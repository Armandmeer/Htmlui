NUVEX CLOUD ACCESS - HTMLUI UPDATE
Gebaseerd op GitHub Htmlui commit 32c8881e053904debe1a2801d89bfecd7a03f7cc.
Stop Nuvex. Kopieer de bestanden uit deze ZIP naar de Nuvex-map naast package.json. Start Nuvex opnieuw.
Je accounts, instellingen en bestaande gegevens worden niet meegeleverd of overschreven.
Ga naar Instellingen, ontgrendel als admin en open Nuvex Cloud Access.
Standaardadres: https://cloud.nuvexai.nl (door gebruiker opgegeven; beschikbaarheid niet bevestigd).
Voor testen: vul het actuele HTTPS-adres uit het cloudserver-dashboard in.
Vink Cloud Access inschakelen aan. Registratie en accountsynchronisatie starten automatisch.
Adres toepassen werkt alleen als Cloud Access aan staat. Uitgeschakeld wordt geen eigen URL bewaard.
Uitschakelen verwijdert nuvex_cloud_access.json inclusief adres en sleutel, en probeert de cloudregistratie in te trekken.
De vaste module-default blijft aanwezig; na uitschakelen staat het veld weer op cloud.nuvexai.nl.
Bij een nieuw adres wordt de oude registratie ingetrokken en een nieuwe installatiesleutel aangemaakt.
Bij netwerkproblemen probeert Nuvex opnieuw, ook na herstart.
HTTPS-certificaten worden gecontroleerd. Er is geen onveilige TLS-bypass.
De bijgeleverde publieke CA is alleen voor de eerder geverifieerde lokale Pi op 192.168.40.119.
Een tijdelijke Cloudflare URL gebruikt de normale publieke certificaatcontrole.
De oude Cloudflare-configuratie wordt niet meer gebruikt; cloudflare_portal.json wordt niet automatisch verwijderd.
Deze functie registreert systemen. Remote bediening via de cloudserver is nog niet gebouwd.
Testbestand: node --test nuvex-cloud.test.js

Validatie: voer npm test uit voor de Cloud Access-tests en bestaande regressietests.
