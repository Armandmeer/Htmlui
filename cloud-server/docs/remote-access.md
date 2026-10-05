# Ontwerp voor remote toegang (nog niet geïmplementeerd)

## Verbinding

De Nuvex-agent opent zelf een persistente WSS-verbinding op poort 443 naar de cloudrelay. De relay koppelt de verbinding aan de bestaande installatie-identiteit. Beide richtingen gebruiken dezelfde uitgaande verbinding; er is geen port forwarding nodig. Herverbinding gebruikt exponential backoff met jitter. Heartbeats, maximale berichtgrootte, backpressure en sessielimieten voorkomen onbeperkt resourcegebruik. Nginx vereist expliciete WebSocket upgrade-configuratie: https://nginx.org/en/docs/http/websocket.html .

## Authenticatie en toestemming

1. De gebruiker logt in bij de cloudapp met een eigen identiteit en MFA. De platform-admin is geen automatische gebruiker van een klantinstallatie.
2. Een installatie heeft een expliciete toegangsrelatie met de geverifieerde identiteit. Een e-mailadres uit een registratie is daarvoor onvoldoende. Nuvex moet deze relatie lokaal bevestigen; een e-mailwijziging geeft geen toegang aan de nieuwe eigenaar van dat adres.
3. De cloud geeft na controle een ondertekend sessieticket uit, geldig voor maximaal 60 seconden, met installatie-ID, gebruiker-ID, audience, nonce en toegestane acties. De Nuvex-agent valideert het ticket en lokale rechten, verbruikt de nonce eenmalig en vraagt waar ingesteld lokale toestemming.
4. De lokale Nuvex-login blijft de uiteindelijke autoriteit. Platformbeheer geeft geen toegang tot klantdata. Rollen, intrekking en accountstatus worden lokaal opnieuw gecontroleerd.
5. Een sessie stopt bij deactiveren van Cloud Access, intrekking, verwijderen van een gebruiker, verlopen van een lease of langdurige verbindingsuitval. Stel bijvoorbeeld 15 minuten inactiviteit en maximaal 1 uur totale duur in, met herauthenticatie voor verlenging.

## Transport en scope

Begin met een beperkte Nuvex-API via de relay, met een allowlist van concrete acties. Geef de cloud geen generieke HTTP-proxy naar willekeurige URL's, geen LAN-toegang en geen shell. De agent kiest uitsluitend een vaste lokale Nuvex-interface; valideer requestpaden, headers, methodes en bodygrootte. Forward nooit platformcookies naar Nuvex.

Voor een complete lokale webinterface: gebruik geïsoleerde origins per sessie/installatie, scheid cookies, verwijder hop-by-hop headers en voorkom open redirects, SSRF en cross-installation verzoeken. Dit vereist extra implementatie en beveiligingstests; alleen een iframe of URL doorsturen voldoet niet.

Gebruik voor end-to-end bescherming een bestaand, beoordeeld protocol voor sleuteluitwisseling en encryptie tussen app/browser en Nuvex-agent. Bind de geverifieerde device public key aan de koppeling en verifieer die buiten de relay om; een door de relay vervangbare sleutel biedt geen bescherming tegen die relay. Ontwerp geen eigen cryptografie. TLS op beide relayverbindingen is transportencryptie en geeft de relay toegang tot inhoud; end-to-end encryptie moet afzonderlijk worden gebouwd en getoetst.

## Voorwaarden voor implementatie

- Device-identiteit met sleutelpaar, veilige opslag, sleutelrotatie en herstelprocedure.
- Gecontroleerde gebruikerskoppeling, MFA en lokale autorisatie per actie.
- Sessietickets en replaypreventie, directe intrekking, time-outs en limieten.
- Audit van sessiestart, einde en toestemming; geen inhoud, wachtwoorden of tokens loggen.
- Tests voor twee verschillende installaties, cross-tenant toegang, ingetrokken accounts, ticketreplay, disconnects en kwaadaardige proxyrequests.

De huidige registratie met bearer-tokens is alleen de eerste fase. Zij activeert dit remote protocol niet.
