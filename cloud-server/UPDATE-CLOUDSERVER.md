# Bestaande Nuvex-cloudserver bijwerken

Deze update bewaart de bestaande database, accounts, registraties, certificaten en tunnelconfiguratie.

## Voorbereiding

1. Werk eerst de lokale Nuvex-server bij via GitHub.
2. Open daar **Settings > Nuvex Cloud Access**.
3. Vul een herkenbare systeemnaam in en noteer het getoonde server-MAC-adres.

## Cloudserver bijwerken

Kopieer de zip naar de Raspberry Pi, pak deze uit en open een terminal in de uitgepakte map:

```sh
sudo python3 deploy/update_portal.py
```

Het updatescript maakt eerst een back-up onder `/var/backups`, vervangt de applicatiebestanden, werkt de Nginx-proxyconfiguratie bij en herstart `nginx` en `nuvex-cloud`.

## MAC-adres toestaan

1. Open na de update `https://jouw-cloudadres/admin`.
2. Log in als beheerder.
3. Voeg onder **Toegestane Nuvex-servers** het genoteerde MAC-adres en een herkenbare naam toe.
4. Controleer na maximaal een minuut of het systeem online en de cloudrelay actief is.

Zolang een MAC-adres niet in de toelatingslijst staat, worden registratie, heartbeat en cloudrelay voor die Nuvex-server geweigerd.
