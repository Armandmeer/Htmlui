# Koppeling met Nuvex AI 3.0

De actuele bron is gelezen in `C:\Users\Armand\Downloads\Nuvex Ai 3.0\Nuvex Ai 3.0` (packageversie 3.0.0). De bron is niet gewijzigd.

Bevindingen: `server.js` bewaart gebruikers in `{ "users": [...] }` in `users.json`. Accounts hebben `email`, `role` en `disabled`; het eerste bootstrapaccount heeft `createdAt`. `create-user.js` en later toegevoegde accounts hebben niet altijd registratiedatums. Daarom gebruikt de adapter alleen het eerste record als dat bootstrapmetadata heeft; anders moet je het oorspronkelijke adres expliciet opgeven. Reeds verwijderde historische accounts zijn niet betrouwbaar te reconstrueren uit dit bestand.

De bestaande `/api/portal/cloudflare/*` routes beheren een Cloudflare-tunnel die de lokale Nuvex-server publiceert. Dit is afzonderlijk van centrale registratie. De nieuwe client leest `users.json` rechtstreeks en stuurt alleen e-mail, rol en disabled-status. Hij stuurt geen salt of passwordHash.

## Nu verbinden

Voer vanuit de Cloud acces-map uit (vervang URL en systeemnaam):

```powershell
python client.py enable --url https://cloud.jouwdomein.nl --nuvex-dir "C:\Users\Armand\Downloads\Nuvex Ai 3.0\Nuvex Ai 3.0" --name "Nuvex thuis"
python client.py run --url https://cloud.jouwdomein.nl --nuvex-dir "C:\Users\Armand\Downloads\Nuvex Ai 3.0\Nuvex Ai 3.0" --name "Nuvex thuis"
```

Zo nodig gebruik bij enable `--first-email eigenaar@example.com`. Optioneel kiest `--admin-email admin@example.com` een specifieke actieve admin als primaire beheerder; de cloud toont alle overige admins ook in de accountlijst. Op Linux gebruik je het Nuvex-installatiepad. Start `run` als eigen service met toegang tot users.json en een afgeschermd client-state.json. De GUI-optie is nog niet in Nuvex aangebracht.

## GUI-integratiepunt

Plaats de optie **Nuvex Cloud Access** onder de bestaande ontgrendelde Instellingen/Portal-sectie, naast de bestaande Cloudflare-optie. Voeg routes `/api/portal/nuvex-cloud/status`, `/enable` en `/disable` toe met dezelfde controle op `authSession(req)`, adminrol en `extendSettingsAccess(settingsTokenFromRequest(req))`, plus Origin/CSRF-controle voor mutaties. De cloud-URL komt uit een vertrouwde installatieconfiguratie, niet uit willekeurige clientinput (SSRF voorkomen).

De enable-route voert dezelfde registratie uit als client.py en bewaart de token in een private config. Start synchronisatie eenmaal bij serverstart als enabled=true. Disable trekt de token in, stopt synchronisatie en verwijdert lokaal de token; bij offline disable stop je meteen lokaal en plan je intrekking bij de cloud, of trek je via het clouddashboard in. Status geeft uitsluitend installatie-ID, enabled, laatst geslaagde heartbeat en een veilige foutmelding terug, nooit token of koppelcode.

Voeg de private config ook toe aan de updatebescherming (`protectedNames` in server.js), statische-bestandsblokkade en back-upbeleid. Voer geen shellcommando uit met gebruikersinput om de Pythonclient aan te sturen. Een native Node-adapter met HTTPS en deze API verdient voor de uiteindelijke geïntegreerde optie de voorkeur.
