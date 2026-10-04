# KNX-weerstation koppeling

De buitenweerfunctie herkent apparaten of gekoppelde drivers met type, category of baseType `weather`, `weatherstation` of `weather-station`.

Gebruik `outdoorTemperatureGa` voor het KNX-groepsadres met DPT 9.001 (°C). Ook `temperatureGa` en `measuredGa` worden ondersteund. `parameters.outdoorTemperatureGa` en `parameters.temperatureGa` worden eveneens herkend.

De server leest dit adres bij verbinden en bij het verversen van feedbackabonnementen. GroupValueWrite en GroupValueResponse worden als temperatuur ingelezen. Er worden geen temperatuurwaarden naar het weerstation geschreven.

Zodra een weerstation is geconfigureerd krijgt dit voorrang. Zonder meting, bij een verbroken verbinding of na een uur zonder meting wordt geen temperatuur getoond. Alleen als er geen weerstation is geconfigureerd wordt Buienradar gebruikt.

De locatie wordt eenmalig bepaald via het publieke internetadres van de server. Instellingen → Locatie & buitenweer toont de gekozen locatie en ondersteunt handmatige plaatskeuze of opnieuw automatisch bepalen. De opgeslagen locatie staat in `weather-config.json` en blijft behouden bij updates.
