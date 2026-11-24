import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CfnOutput, Duration, Fn, RemovalPolicy, Size, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface AlbaydarStackProps extends StackProps {
  /** beta | produccion: nombre de los recursos y de los parámetros de SSM (/albaydar/<entorno>/). */
  entorno: 'beta' | 'produccion';
  /** Rama de GitHub que puede desplegar en este entorno (develop → beta, main → producción). */
  ramaDespliegue: string;
  /** Correo que recibe las alarmas y los avisos del presupuesto. */
  correoAvisos: string;
  /** Presupuesto mensual en USD (aviso al 80 % real y al 100 % previsto). */
  presupuestoUsd: number;
  /** Tamaño del volumen de datos (GB). */
  datosGb: number;
}

const ORG_GITHUB = 'Ceroone-Technology';
/**
 * Etiquetas de coste de la empresa (activas en Facturación): con ellas se ve desde el primer día
 * cuánto cuesta cada cliente y proyecto. Mismo formato que el resto de la cuenta.
 */
export const ETIQUETAS = { CLIENT: 'Albaydar', PROJECT_NAME: 'albaydar-gestion-academica' } as const;
const REPOS = ['albaydar-api', 'app-albaydar-front'];

/**
 * Albaydar en AWS (patrón EC2 de Subvfy, 23/11/2026):
 *  - EC2 t4g.micro (1 GB, ARM) con Docker: API y PostgreSQL (deploy/docker-compose.prod.yml).
 *  - Volumen EBS de datos aparte (/data), cifrado, que sobrevive a la instancia, con snapshot
 *    diario (DLM, 7 días). IP elástica.
 *  - Grupo de seguridad: solo el puerto 80 y solo desde CloudFront; sin SSH (Session Manager).
 *  - CloudFront: / → front en S3 (OAC, rutas de la SPA a index.html) y /api/* → EC2, con la
 *    cabecera secreta X-Origin-Verify (la API rechaza lo que no la traiga).
 *  - S3: front, uploads (ficheros de la API), backups (pg_dump, 30 días) y releases (despliegues).
 *  - Rol de la instancia (S3, SSM Parameter Store /albaydar/<entorno>/, Session Manager) y rol
 *    de despliegue de GitHub por OIDC (sin claves guardadas).
 *  - Alarmas (recuperación automática, CPU y créditos de CPU) por correo y presupuesto mensual.
 */
export class AlbaydarStack extends Stack {
  constructor(scope: Construct, id: string, props: AlbaydarStackProps) {
    super(scope, id, props);
    const { entorno } = props;
    const nombre = (parte: string) => `albaydar-${entorno}-${parte}-${this.account}`;

    Tags.of(this).add('CLIENT', ETIQUETAS.CLIENT);
    Tags.of(this).add('PROJECT_NAME', ETIQUETAS.PROJECT_NAME);
    Tags.of(this).add('Environment', entorno);

    // ── Red: una subred pública, sin NAT (lo barato) ──────────────────────────
    const vpc = new ec2.Vpc(this, 'Red', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'publica', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const grupo = new ec2.SecurityGroup(this, 'Firewall', {
      vpc,
      description: `Albaydar ${entorno}: solo HTTP desde CloudFront`,
      allowAllOutbound: true,
    });
    // Lista de IP de CloudFront (origin-facing), la misma que usa Subvfy.
    const cloudFrontIps = ec2.PrefixList.fromLookup(this, 'IpsCloudFront', {
      prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
    });
    grupo.addIngressRule(ec2.Peer.prefixList(cloudFrontIps.prefixListId), ec2.Port.tcp(80), 'HTTP desde CloudFront');

    // ── Buckets ───────────────────────────────────────────────────────────────
    const comun: Partial<s3.BucketProps> = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    };
    const front = new s3.Bucket(this, 'Front', { ...comun, bucketName: nombre('front') });
    const uploads = new s3.Bucket(this, 'Uploads', {
      ...comun,
      bucketName: nombre('uploads'),
      // Si se borra o se pisa un fichero por error, se recupera durante 30 días.
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
    });
    const backups = new s3.Bucket(this, 'Backups', {
      ...comun,
      bucketName: nombre('backups'),
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });
    const releases = new s3.Bucket(this, 'Releases', {
      ...comun,
      bucketName: nombre('releases'),
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });

    // ── Servidor ──────────────────────────────────────────────────────────────
    const rolServidor = new iam.Role(this, 'RolServidor', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: `Albaydar ${entorno}: servidor (S3, SSM, Session Manager)`,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    uploads.grantReadWrite(rolServidor);
    uploads.grantDelete(rolServidor);
    backups.grantPut(rolServidor);
    backups.grantRead(rolServidor);
    releases.grantRead(rolServidor);
    rolServidor.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParametersByPath', 'ssm:GetParameter', 'ssm:GetParameters'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/albaydar/${entorno}`, `arn:aws:ssm:${this.region}:${this.account}:parameter/albaydar/${entorno}/*`],
      }),
    );
    // Descifrar los SecureString (clave aws/ssm), solo a través de SSM.
    rolServidor.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }),
    );

    const userData = ec2.UserData.custom(readFileSync(join(__dirname, 'user-data.sh'), 'utf8').replace(/__ENTORNO__/g, entorno));
    const servidor = new ec2.Instance(this, 'Servidor', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: grupo,
      role: rolServidor,
      userData,
      requireImdsv2: true,
      blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(8, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }) }],
    });
    Tags.of(servidor).add('Name', `albaydar-${entorno}`);

    // Volumen de datos aparte: PostgreSQL vive aquí y no se borra con la instancia.
    const datos = new ec2.Volume(this, 'Datos', {
      availabilityZone: servidor.instanceAvailabilityZone,
      size: Size.gibibytes(props.datosGb),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Tags.of(datos).add('Backup', `albaydar-${entorno}`);
    new ec2.CfnVolumeAttachment(this, 'DatosConectados', { instanceId: servidor.instanceId, volumeId: datos.volumeId, device: '/dev/sdf' });

    const ip = new ec2.CfnEIP(this, 'IpFija', { tags: [{ key: 'Name', value: `albaydar-${entorno}` }] });
    new ec2.CfnEIPAssociation(this, 'IpFijaServidor', { allocationId: ip.attrAllocationId, instanceId: servidor.instanceId });
    // DNS público de la IP elástica (CloudFront necesita un nombre, no una IP).
    const dnsServidor = `ec2-${Fn.join('-', Fn.split('.', ip.ref))}.${this.region}.compute.amazonaws.com`;

    // Snapshot diario del volumen de datos, se guardan 7.
    const rolDlm = new iam.Role(this, 'RolCopias', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSDataLifecycleManagerServiceRole')],
    });
    new dlm.CfnLifecyclePolicy(this, 'CopiasDiarias', {
      description: `Albaydar ${entorno} - snapshot diario del volumen de datos`,
      state: 'ENABLED',
      executionRoleArn: rolDlm.roleArn,
      policyDetails: {
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: 'Backup', value: `albaydar-${entorno}` }],
        schedules: [
          {
            name: 'Diario',
            copyTags: true,
            createRule: { interval: 24, intervalUnit: 'HOURS', times: ['02:00'] },
            retainRule: { count: 7 },
          },
        ],
      },
    });

    // ── CloudFront: front en S3 y /api/* al servidor ─────────────────────────
    // El mismo valor que la API espera (deploy/crear-secretos.sh lo crea como String).
    const secretoOrigen = ssm.StringParameter.valueForStringParameter(this, `/albaydar/${entorno}/CLOUDFRONT_ORIGIN_SECRET`);
    const rutasSpa = new cloudfront.Function(this, 'RutasSpa', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Rutas de la SPA sin extension a index.html',
      code: cloudfront.FunctionCode.fromInline(
        'function handler(event) { var r = event.request; if (r.uri.indexOf(".") === -1) { r.uri = "/index.html"; } return r; }',
      ),
    });
    const distribucion = new cloudfront.Distribution(this, 'Cdn', {
      comment: `Albaydar ${entorno}`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(front),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
        functionAssociations: [{ function: rutasSpa, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(dnsServidor, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            customHeaders: { 'X-Origin-Verify': secretoOrigen },
            readTimeout: Duration.seconds(60),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
    });

    // ── Avisos: alarmas y presupuesto ────────────────────────────────────────
    const avisos = new sns.Topic(this, 'Avisos', { displayName: `Albaydar ${entorno}` });
    avisos.addSubscription(new snsSubs.EmailSubscription(props.correoAvisos));
    const metrica = (metricName: string, statistic = 'Maximum') =>
      new cloudwatch.Metric({ namespace: 'AWS/EC2', metricName, dimensionsMap: { InstanceId: servidor.instanceId }, statistic, period: Duration.minutes(5) });

    const fallaHardware = new cloudwatch.Alarm(this, 'AlarmaRecuperar', {
      alarmDescription: 'Fallo del hardware de AWS: la instancia se recupera sola',
      metric: metrica('StatusCheckFailed_System'),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    fallaHardware.addAlarmAction(new cwActions.Ec2Action(cwActions.Ec2InstanceAction.RECOVER), new cwActions.SnsAction(avisos));
    const fallaInstancia = new cloudwatch.Alarm(this, 'AlarmaInstancia', {
      alarmDescription: 'La instancia no responde (comprobación de estado)',
      metric: metrica('StatusCheckFailed_Instance'),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    fallaInstancia.addAlarmAction(new cwActions.SnsAction(avisos));
    const cpu = new cloudwatch.Alarm(this, 'AlarmaCpu', {
      alarmDescription: 'CPU por encima del 80 % durante 15 minutos',
      metric: metrica('CPUUtilization', 'Average'),
      threshold: 80,
      evaluationPeriods: 3,
    });
    cpu.addAlarmAction(new cwActions.SnsAction(avisos));
    const creditos = new cloudwatch.Alarm(this, 'AlarmaCreditosCpu', {
      alarmDescription: 'Quedan pocos créditos de CPU (t4g): la instancia va a ir lenta',
      metric: metrica('CPUCreditBalance', 'Minimum'),
      threshold: 20,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    });
    creditos.addAlarmAction(new cwActions.SnsAction(avisos));

    new budgets.CfnBudget(this, 'Presupuesto', {
      budget: {
        budgetName: `albaydar-${entorno}`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.presupuestoUsd, unit: 'USD' },
        // Solo lo de este proyecto (etiqueta PROJECT_NAME, activa en Facturación).
        costFilters: { TagKeyValue: ['user:PROJECT_NAME$' + ETIQUETAS.PROJECT_NAME] },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.correoAvisos }],
        },
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.correoAvisos }],
        },
      ],
    });

    // ── Despliegue desde GitHub (OIDC, sin claves) ───────────────────────────
    const github = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHub',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const rolDespliegue = new iam.Role(this, 'RolDespliegue', {
      roleName: `albaydar-${entorno}-github-deploy`,
      description: `Albaydar ${entorno}: despliegue desde GitHub Actions (rama ${props.ramaDespliegue})`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(github.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': REPOS.map((r) => `repo:${ORG_GITHUB}/${r}:ref:refs/heads/${props.ramaDespliegue}`) },
      }),
    });
    front.grantReadWrite(rolDespliegue);
    front.grantDelete(rolDespliegue);
    releases.grantReadWrite(rolDespliegue);
    rolDespliegue.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribucion.distributionId}`],
      }),
    );
    rolDespliegue.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/${servidor.instanceId}`, `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`],
      }),
    );
    rolDespliegue.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetCommandInvocation', 'ssm:ListCommandInvocations'], resources: ['*'] }));

    // ── Salidas ──────────────────────────────────────────────────────────────
    new CfnOutput(this, 'Url', { value: `https://${distribucion.distributionDomainName}`, description: 'URL de la aplicación' });
    new CfnOutput(this, 'DistribucionId', { value: distribucion.distributionId });
    new CfnOutput(this, 'ServidorId', { value: servidor.instanceId });
    new CfnOutput(this, 'IpServidor', { value: ip.ref });
    new CfnOutput(this, 'BucketFront', { value: front.bucketName });
    new CfnOutput(this, 'BucketUploads', { value: uploads.bucketName });
    new CfnOutput(this, 'BucketBackups', { value: backups.bucketName });
    new CfnOutput(this, 'BucketReleases', { value: releases.bucketName });
    new CfnOutput(this, 'RolDespliegueArn', { value: rolDespliegue.roleArn });
  }
}
