HTML UI 3.1 - starten op Windows
================================

Snel starten
------------
1. Pak HTMLUI3.1.zip volledig uit naar een gewone map.
2. Dubbelklik op START_WINDOWS.bat.
3. Laat het zwarte servervenster open zolang de Html UI gebruikt wordt.
4. Open op deze pc: http://localhost:3010/
5. Open op een telefoon of touchscreen in hetzelfde netwerk:
   http://<IP-ADRES-VAN-DEZE-PC>:3010/

IP-adres van de pc vinden
-------------------------
Open Opdrachtprompt en voer uit:
  ipconfig

Gebruik het IPv4-adres van de actieve netwerkadapter. Voorbeeld:
  http://192.168.200.196:3010/

Belangrijk
----------
- Node.js en de benodigde modules zijn in deze zip opgenomen.
- De huidige ruimtes, apparaten, groepsadressen en instellingen staan in
  smarthome_state.json en zijn in het pakket opgenomen.
- De GitHub-sleutel is om veiligheidsredenen NIET opgenomen.
  Vul op de andere pc bij Settings > GitHub updates opnieuw de repository-URL
  en de sleutel in.
- Sta de verbinding toe wanneer Windows Firewall bij de eerste start daarom
  vraagt. Kies minimaal Privénetwerken.
- Start maar één exemplaar tegelijk op poort 3010.
- De KNX-interface en de nieuwe pc moeten elkaar via het netwerk kunnen bereiken.

Server stoppen
--------------
Ga naar het zwarte servervenster en druk Ctrl+C. Bevestig eventueel met J/Y.

Problemen
---------
- Pagina opent lokaal niet: controleer of START_WINDOWS.bat nog draait.
- Andere apparaten zien de pagina niet: controleer hetzelfde wifi/LAN-netwerk,
  het IPv4-adres en Windows Firewall.
- Poort 3010 is bezet: stop eerst een andere Html UI-server.
- GitHub-update: configureer URL en sleutel opnieuw via Settings. De update
  bewaart smarthome_state.json en maakt voor installatie een herstelkopie.
