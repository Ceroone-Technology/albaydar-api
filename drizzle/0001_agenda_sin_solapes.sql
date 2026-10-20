-- Garantía en la propia base de datos: dos franjas activas de la agenda
-- (reservadas, confirmadas o bloqueadas) nunca pueden solaparse en el tiempo.
-- Si dos familias o dos personas de secretaría intentan ocupar la misma hora
-- a la vez, PostgreSQL rechaza la segunda (error 23P01) y la API responde 409.
ALTER TABLE "franjas_agenda"
  ADD CONSTRAINT "franjas_sin_solape"
  EXCLUDE USING gist (tstzrange("inicio", "fin", '[)') WITH &&)
  WHERE ("estado" <> 'LIBERADA');
