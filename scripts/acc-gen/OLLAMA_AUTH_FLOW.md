# Ollama.com Authentication Flow

## Overview

Автоматизированная авторизация на Ollama.com с верификацией через email и SMS.

## Последовательность шагов

### Шаг 1: Регистрация/Вход
- **URL**: `https://signin.ollama.com/sign-up`
- **Действие**: Ввод email → кнопка "Continue"

### Шаг 2: Пароль
- **URL**: `https://signin.ollama.com/sign-up` (страница пароля)
- **Действие**: Ввод пароля (из accounts.json) → кнопка "Continue"

### Шаг 3: Email Verification
- **URL**: `https://signin.ollama.com/sign-up` (страница верификации)
- **Действие**: 
  1. Получить 6-значный код из последнего письма на почте
  2. Ввести код в форму верификации
  3. Кнопка "Continue"

### Шаг 4: Phone Verification (SMS)
- **URL**: `https://signin.ollama.com/sign-up` (страница телефона)
- **Действие**:
  1. Заказать номер через SMS-провайдера (Hero-SMS)
     - Категория: "Другие" (other)
     - Страна: Великобритания (UK, country code: 44 или GB)
     - Цена: ~4-5 центов (самый дешёвый)
  2. Ввести номер телефона в форму
  3. Ждать SMS (до 5 минут, может быть быстрее)
  4. Получить код из SMS
  5. Ввести код верификации:
     - **Левое поле**: 6-значный SMS код
     - **Правое поле**: номер телефона (с кодом страны)
  6. Кнопка "Verify" / "Continue"

### Шаг 5: Получение API Key
- **URL**: `https://ollama.com/settings/keys`
- **Действие**:
  1. Кнопка "Add API Key"
  2. Кнопка "Generate API Key"
  3. Скопировать сгенерированный API key

### Шаг 6: Сохранение в конфиг
- **Файл**: `config.yaml` (runtime directory)
- **Структура** (около строки 100):
```yaml
- name: Ollama
  base-url: https://ollama.com/v1
  api-key-entries:
    - api-key: sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

## Переменные окружения

| Переменная | Описание | Пример |
|------------|----------|--------|
| `HERO_SMS_API_KEY` | API ключ SMS-провайдера | `abc123...` |
| `HERO_SMS_BASE_URL` | URL API SMS-провайдера | `https://hero-sms.com/stubs/handler_api.php` |
| `HERO_SMS_COUNTRIES` | Коды стран для SMS (UK=44 или GB) | `44,151,15` |
| `HERO_SMS_SERVICE` | Сервис SMS (другие) | `dr` или `other` |
| `HERO_SMS_POLL_TIMEOUT_SEC` | Таймаут ожидания SMS | `300` (5 минут) |
| `HERO_SMS_POLL_INTERVAL_MS` | Интервал опроса SMS | `3000` |
| `CODEX_BROWSER_ENGINE` | Движок браузера | `auto`, `puppeteer`, `playwright` |
| `CODEX_SCREENSHOTS` | Режим скриншотов | `true`, `false` |

## Структура accounts.json

```json
[
  {
    "email": "user@example.com",
    "password": "SecurePassword123!",
    "name": "John Doe",
    "birthYear": 2000,
    "birthMonth": 1,
    "birthDay": 15
  }
]
```

## Селекторы форм (предварительные)

| Страница | Элемент | Селектор |
|----------|---------|----------|
| Email | Input | `input[type="email"]`, `input[name="email"]` |
| Password | Input | `input[type="password"]`, `input[name="password"]` |
| Email Code | Input | `input[autocomplete="one-time-code"]`, `input[maxlength="6"]` |
| Phone | Input | `input[type="tel"]`, `input[autocomplete="tel"]` |
| SMS Code | Left Input | `input[inputmode="numeric"][maxlength="6"]` (первый) |
| SMS Code | Right Input (Phone) | `input[inputmode="tel"]` (второй) |
| Continue Button | Button | `button[type="submit"]`, `button:contains("Continue")` |
| API Key Page | Generate Button | `button:contains("Generate")`, `button:contains("Add API Key")` |
| API Key Display | Key Value | `.api-key-value`, `code`, `[data-testid="api-key"]` |

## Обработка ошибок

1. **Email не пришёл**: Подождать 30 сек, обновить страницу
2. **SMS не пришёл**: Retry с другим номером (до 5 попыток)
3. **Номер не принимается**: Попробовать другой формат (+44 vs 44)
4. **API Key не генерируется**: Проверить сессию, переавторизоваться

## Формат выходных данных

```json
{
  "email": "user@example.com",
  "api_key": "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
  "auth_file": "ollama-1234567890.json",
  "status": "success"
}
```

## Отличия от Codex Flow

| Аспект | Codex | Ollama |
|--------|-------|--------|
| OAuth | Да (localhost:1455) | Нет (прямой вход) |
| Email верификация | Нет | Да (6-digit code) |
| Phone верификация | Да | Да |
| SMS поля | Одно (код) | Два (код + номер) |
| API Key получение | Автоматически | settings/keys страница |
| SMS категория | OpenAI-specific | "Другие", UK |
