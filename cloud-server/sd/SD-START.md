# Automatische installatie vanaf SD-kaart

Dit is een pakket voor een **bestaande Raspberry Pi OS-kaart**, geen bootable .img. Ondersteunt Raspberry Pi OS met systemd, Python 3, NetworkManager en `/boot/firmware` (Bookworm/Trixie). De bootprocedure is nog niet op echte Pi-hardware getest. Gebruik een eigen cloud-Pi en bewaar eerst een back-up van de kaart.

1. Schrijf Raspberry Pi OS Lite met Raspberry Pi Imager. Stel je gebruikersnaam, SSH en netwerk in. Laat de Pi **eenmaal normaal opstarten** om de OS- en Imager-initialisatie af te ronden. Sluit hem netjes af en steek de SD-kaart in je Windows-computer. Dit voorkomt conflicten met de Imager-opstarttaak.
2. Pak dit hele ZIP-bestand uit op je computer. Dubbelklik op **SD-KAART-VOORBEREIDEN.cmd**. Python 3 op je computer is vereist. Kies de stationsletter van de zichtbare **bootfs**-partitie en stel je admin-e-mailadres en wachtwoord in. Het programma kopieert de installer en past de opstartregel aan. Het formatteert geen kaart.
3. Werp de kaart veilig uit. Plaats hem in de Pi en verbind de Pi via **ethernet met internet**. Zet hem aan. De installatie downloadt OS-pakketten, installeert Nuvex, maakt je gekozen adminaccount aan en herstart de Pi. Reken op enkele minuten; onderbreek de voeding niet.
4. Open **https://PI-IP-ADRES:8443** in je browser en log in. Je vindt het IP-adres in je router. Lokaal HTTPS gebruikt een zelfondertekend certificaat; vergelijk de SHA256-vingerafdruk via SSH met `sudo openssl x509 -in /etc/nuvex-cloud/tls/server.crt -noout -fingerprint -sha256` voordat je het vertrouwt. Lees `START-HIER.md` in het applicatiepakket voor uitleg.

Je kunt op de Pi via SSH ook `cat /boot/firmware/nuvex-status.txt` lezen. Dit bestand bevat na installatie het juiste browseradres. `nuvex-install.log` bevat het installatieverloop, geen leesbaar adminwachtwoord. Het pakket start Nuvex daarna automatisch bij iedere boot via systemd.

## Als installatie mislukt

De eenmalige bootinstelling wordt verwijderd vóór installatie: de Pi blijft daardoor niet in een installatielus. Hij herstart na succes of fout naar de normale OS-start. Lees `nuvex-status.txt` en `nuvex-install.log`. Herstel internet/netwerk en voer via SSH uit:

```sh
sudo python3 /var/tmp/nuvex-provision/nuvex-cloud-pi/deploy/install.py --admin-config /boot/firmware/nuvex-install.json
```

Geef daarbij zo nodig `--ip` en `--public-url` opnieuw op. Verwijder `/boot/firmware/nuvex-install.json` na geslaagd herstel; daarin staat de passwordhash (geen plaintext wachtwoord, maar wel gevoelig voor offline wachtwoordaanvallen).

Als de Pi door een bootprobleem niet start: plaats de kaart in de computer en herstel `cmdline.txt` vanuit `cmdline.nuvex-backup.txt`. De voorbereiding weigert bestaande Imager-opstarttaken en afwijkende cmdline-configuraties. Deze installer is geen universele firmware/image en maakt een lege SD-kaart niet bootable.

Voor registraties van Nuvex-systemen buiten het LAN is een publieke HTTPS-hostname met uitgaande tunnel nodig. De opgegeven publieke URL maakt alleen login op die origin mogelijk; het domein en de tunnel worden niet automatisch aangemaakt. Zie `START-HIER.md` in het meegeleverde applicatiepakket.
