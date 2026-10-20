-- Solo se ejecuta la primera vez que se crea el volumen de datos.
-- Base de datos aparte para `npm test`, que la vacía en cada ejecución.
CREATE DATABASE albaydar_test OWNER albaydar;
