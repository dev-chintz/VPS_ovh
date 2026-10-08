# Wersja Netlify – monitor w chmurze, za darmo

Funkcja cykliczna Netlify (Scheduled Function) co 5 minut sprawdza dostępność VPS-2 2027
i wysyła wiadomość na Telegram. Stan powiadomień trzyma w Netlify Blobs, więc nie
dostaniesz duplikatów. Pod adresem projektu (`https://<nazwa>.netlify.app`) jest
strona statusu z wynikiem ostatniego sprawdzenia.

Netlify nie uruchamia Pythona, dlatego ta wersja jest w JavaScripcie. Logika jest taka
sama jak w wersji lokalnej.

## Co jest w folderze

| Plik | Rola |
|---|---|
| `netlify/functions/check-vps.mjs` | sprawdzanie co 5 min (cron `*/5 * * * *`) |
| `netlify/functions/status.mjs` | `GET /api/status` dla strony statusu |
| `lib/monitor-core.mjs` | cała logika: OVH, deduplikacja, Telegram |
| `public/index.html` | strona statusu |
| `scripts/cli.mjs` | lokalne komendy: `dry-run`, `chat-id`, `test-telegram` |

## Wymagania

- konto na https://app.netlify.com (darmowy plan wystarczy),
- bot Telegram: token i ID czatu (instrukcja niżej),
- opcjonalnie **Node.js 22.12 lub nowszy** na komputerze – tylko do lokalnego
  sprawdzenia (`npm run dry-run`) i wdrożenia przez CLI.

## Telegram: token i ID czatu

1. W Telegramie otwórz **@BotFather** (niebieski znaczek weryfikacji), wyślij `/newbot`,
   podaj nazwę i login kończący się na `bot`.
2. BotFather odeśle **token** `123456789:AAH...` → to `TELEGRAM_BOT_TOKEN`.
3. Otwórz swojego bota, kliknij **Start** i napisz cokolwiek.
4. Otwórz w przeglądarce `https://api.telegram.org/bot<TOKEN>/getUpdates` (token zamiast
   `<TOKEN>`) i znajdź `"chat":{"id":987654321` → ta liczba to `TELEGRAM_CHAT_ID`.
   Jeśli widzisz `"result":[]`, napisz do bota jeszcze raz i odśwież.
   Tego adresu nikomu nie pokazuj, bo zawiera token.

## 1. Sprawdzenie lokalne przed wdrożeniem (opcjonalne)

W folderze repozytorium:

```sh
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

Wpisz w `.env` swój `TELEGRAM_BOT_TOKEN`, a potem:

```sh
npm run chat-id             # pokaże ID czatu -> wpisz jako TELEGRAM_CHAT_ID w .env
npm run dry-run             # jedno sprawdzenie OVH, wynik na ekranie, nic nie jest wysyłane
npm run test-telegram       # wiadomość testowa na Telegram
```

Plik `.env` służy tylko tym lokalnym komendom. Nie trafia na Netlify.

## 2. Wdrożenie

### Sposób A: z GitHuba (bez instalowania czegokolwiek)

1. W Netlify: *Add new project* → *Import an existing project* → *GitHub* →
   wybierz repozytorium `ovh-vps-monitor` (przy pierwszym razie Netlify poprosi
   o dostęp do repozytoriów na GitHubie).
2. Ustawienia budowania zostaw domyślne – Netlify weźmie je z `netlify.toml`.
3. Przed pierwszym wdrożeniem dodaj zmienne środowiskowe `TELEGRAM_BOT_TOKEN`
   i `TELEGRAM_CHAT_ID` (zaznacz, że to wartości poufne).
4. Kliknij *Deploy*. Każdy kolejny push do gałęzi `main` wdroży nową wersję.

Jeśli zmienne dodasz dopiero po pierwszym wdrożeniu, wdróż ponownie
(*Deploys* → *Trigger deploy*), żeby zaczęły działać.

### Sposób B: Netlify CLI

Wymyśl nazwę projektu – będzie częścią adresu `https://<nazwa>.netlify.app` i musi być
unikalna, np. `ovh-vps-monitor-jan`. W poleceniach poniżej wstaw ją zamiast `NAZWA`.

```sh
npx netlify-cli login                                 # otworzy przeglądarkę, zaloguj się
npx netlify-cli deploy --prod --site-name NAZWA       # tworzy projekt i wdraża
npx netlify-cli env:import .env --site NAZWA          # wysyła token i chat ID z .env
npx netlify-cli deploy --prod --site NAZWA            # ponowne wdrożenie, żeby zmienne zadziałały
```

Jeśli nazwa jest zajęta, wybierz inną. Zamiast `env:import` możesz dodać zmienne
w panelu: Twój projekt → *Project configuration* → *Environment variables* →
`TELEGRAM_BOT_TOKEN` i `TELEGRAM_CHAT_ID` (zaznacz, że to wartości poufne), a potem
wdrożyć ponownie.

Samo przeciągnięcie folderu na Netlify Drop nie wystarczy – funkcja potrzebuje
zbudowania z zależnościami.

## 3. Sprawdzenie, czy działa

1. W panelu Netlify: *Logs* → *Functions* → `check-vps` → **Run now**
   (albo poczekaj do 5 minut).
2. Na Telegram przyjdzie wiadomość „▶️ Monitor VPS-2 2027 uruchomiony”.
3. Otwórz adres projektu (`https://<nazwa>.netlify.app`) – zobaczysz stan każdej
   lokalizacji i czas ostatniego sprawdzenia. Strona odświeża się co minutę.

Logi każdego sprawdzenia są w panelu w tym samym miejscu (*Logs* → *Functions* → `check-vps`).

## Ustawienia (zmienne środowiskowe na Netlify)

Wymagane są tylko `TELEGRAM_BOT_TOKEN` i `TELEGRAM_CHAT_ID`. Pozostałe są opcjonalne
i działają tak samo jak w wersji lokalnej: `PLAN_NAME`, `PLAN_CODES`, `OVH_SUBSIDIARY`,
`PRIORITY_DATACENTERS`, `EUROPE_DATACENTERS`, `NON_EUROPE_DATACENTERS`, `STORAGE`,
`OS_FAMILY`, `NOTIFY_PREORDER`, `ERROR_ALERT_AFTER`, `STARTUP_MESSAGE`.

Dodatkowo `DRY_RUN=true` – funkcja sprawdza i loguje, ale nic nie wysyła.

Po każdej zmianie zmiennych wdróż projekt ponownie.

Częstotliwość zmienisz w `netlify/functions/check-vps.mjs` (`schedule`), np.
`"*/10 * * * *"` = co 10 minut. Cron Netlify działa w czasie UTC, co przy
sprawdzaniu co kilka minut nie ma znaczenia.

## Limity darmowego planu

Darmowy plan Netlify ma **300 kredytów miesięcznie**. Funkcje są liczone w GB-godzinach
(10 kredytów za GB-godzinę według cennika z kwietnia 2026). Sprawdzanie co 5 minut to
ok. 8 600 uruchomień w miesiącu po 1–5 sekund, czyli szacunkowo **25–120 kredytów**.

Po kilku dniach sprawdź zużycie w panelu (*Usage*). Jeśli limit się wyczerpie, Netlify
wstrzyma projekt do końca okresu rozliczeniowego – nic nie zapłacisz, ale monitor
przestanie działać. Strona statusu pokaże wtedy ostrzeżenie „Brak nowych sprawdzeń”.
Jeśli zużycie jest wysokie, zmień sprawdzanie na co 10 minut.

## Wyłączenie monitora

Gdy kupisz VPS: w panelu Netlify usuń projekt (*Project configuration* → *Delete project*)
albo ustaw `DRY_RUN=true` i wdróż ponownie.

## Bezpieczeństwo

- Token i ID czatu są tylko w zmiennych środowiskowych Netlify (i w lokalnym `.env`).
- Nie trafiają do logów (są maskowane jako `***`) ani na stronę statusu.
- Strona statusu jest publiczna, ale pokazuje tylko stan lokalizacji OVH i czasy.
  Ma znacznik `noindex`, więc nie pojawi się w wyszukiwarkach.
