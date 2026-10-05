# Nuvex AI 0.4.1

Cloud Access biedt nu een beveiligde uitgaande relay voor de eigen webinterface en live WebSocket-bediening. Er is geen port forwarding nodig. Het standaard cloudadres blijft https://cloud.nuvexai.nl; tijdelijke HTTPS-adressen zijn ook mogelijk.

Open het centrale cloudportaal en log in met je Nuvex-account. Bij een geldig account op een systeem wordt dat systeem direct geopend. Bij meerdere systemen waarop hetzelfde wachtwoord geldig is, kies je eerst een systeem. De lokale Nuvex-sessie wordt aangemaakt zonder tweede login. Verschillende wachtwoorden geven alleen toegang tot de systemen die met het ingevoerde wachtwoord overeenkomen.

De cloudserver vraagt verificatiegegevens via de geauthenticeerde relay en controleert het wachtwoord zelf. Het browserwachtwoord wordt niet naar geregistreerde apparaten doorgestuurd. Cloud Access vertrouwt de ingestelde cloudserver; gebruik alleen een server die je beheert of vertrouwt. Toegangssleutels blijven server-side.

De cloudserver krijgt dezelfde loginvormgeving als Nuvex. Beheer staat achter de kleine link Inloggen als beheerder en een aparte cloud-adminlogin. Ingetrokken systemen kunnen worden verwijderd; hun oude sleutels blijven geblokkeerd.

Bestaande Nuvex-installatie: stop Nuvex, kopieer de bestanden uit Nuvex-AI-0.4.1-update.zip naar de map naast package.json en start opnieuw. Accounts en systeemconfiguratie worden niet overschreven.

Bestaande cloud-Pi: pak Nuvex-Cloud-Portaal-update.zip uit, open de uitgepakte map en voer sudo python3 deploy/update_portal.py uit. Dit bewaart database, adminaccount en origins, installeert aiohttp en stelt de WebSocket-proxy in. Open daarna / voor gebruikers of /admin voor beheer. Je bestaande Cloudflare Tunnel blijft naar 127.0.0.1:8081 wijzen.

Werk beide kanten bij om remote toegang te gebruiken. Alleen registreren blijft werken met oudere clients. De vernieuwde gateway verwerkt normale HTTP-verzoeken en /ws; continue video- en audio-streams en downloads groter dan 16 MiB worden nog niet via de relay ondersteund. Gelijktijdige tabs delen de gekozen systeemcontext in dezelfde browser.

Tests: npm test voor Nuvex. Voor cloudtests: installeer aiohttp en cryptography in een testomgeving, genereer tests/tls met python tests/generate_test_cert.py en voer python -m unittest discover -s tests -v uit vanuit cloud-server. De volledige integratietest gebruikt een tijdelijke database, TLS en een echte lokale Nuvex-server.
