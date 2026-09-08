# Данные и команды трекера

Node.js 24+, стандартный node:sqlite. Запуск из любого каталога:

```text
node <P>/scripts/tracker.mjs --data <D> init
node <P>/scripts/tracker.mjs --data <D> profile
node <P>/scripts/tracker.mjs --data <D> run-start <D>/materials/run.json
node <P>/scripts/tracker.mjs --data <D> put <D>/materials/vacancy.json
node <P>/scripts/tracker.mjs --data <D> show vacancy-slug
node <P>/scripts/tracker.mjs --data <D> report
```

P/D — абсолютные пути из workflow.md. JSON-ответы команд — для агента; report
также пишет reports/latest.md. Любая ошибка → ненулевой exit, отправлять после неё нельзя.

## Профиль

Шаблон: [profile.json](../templates/profile.json). Объекты в массивах:

- experience: employer, role, start, end, responsibilities, evidence_ids.
- skills: name, level, evidence_ids (уровень со слов кандидата).
- achievements: text, evidence_ids.
- evidence: id, text, source, confirmed (boolean); source — файл/страница/ответ с датой.
- languages: language, level, basis.
- answers: question, answer, evidence_ids, confirmed, share_allowed.
- education: institution, qualification, start, end, evidence_ids.
- search.hard_constraints/preferences: понятные строки условий, не фильтры Hirify.

Дата confirmed_at — ISO 8601. Profile-команда отдаёт hash текущего JSON для разрешения
auto. Хеш зависит от сериализации объекта: изменение/перестановка ключей может
потребовать нового согласования (консервативное поведение).
resume.path — путь относительно D или абсолютный локальный; sha256 — байтов файла.
Пример вычисления в PowerShell: `(Get-FileHash <file> -Algorithm SHA256).Hash.ToLower()`.
readiness и confirmed — утверждения агента по фактической проверке, не автоматическая
проверка истинности биографии. Не отмечать их только ради прохождения команды.

## Входы команд

| Команда | JSON / аргумент |
|---|---|
| run-start | Любой объект с целями/бюджетами; возвращает run_id |
| run-event | run_id, kind, data; сохранять запросы, страницы, квоты, ошибки и ручной отсев |
| run-finish | run_id, status: complete/partial/blocked/failed, reason; можно добавить counters |
| put | Формат вакансии ниже; только для running run и того же profile hash |
| prepare | slug, cover_letter, hirify_profile_id, claims, answers, unresolved |
| approve | slug, user_authorization: точный текст отдельного разрешения |
| policy | mode: review_each или auto; для auto объект auto (см. ниже) |
| begin | slug; выдаёт неизменяемый пакет и attempt_id, но не вызывает Hirify |
| finish | attempt_id, outcome: submitted/failed/unknown, evidence; при submitted application_id строкой |
| resolve | slug, outcome: submitted/failed, evidence; при submitted application_id |
| status | slug, status, note: источник/содержание сообщения пользователя |
| show | slug как обычный аргумент, без JSON |
| list / history / runs / report / profile | Без аргумента |

Вакансия (пример структуры, не реальная вакансия):

```json
{
  "run_id": "ID из run-start",
  "slug": "fictional-role",
  "title": "Вымышленная роль",
  "company": "Fictional Example",
  "url": "https://example.invalid/jobs/fictional-role",
  "route": "hosted",
  "description": "Полный прочитанный текст",
  "read_at": "2026-01-01T00:00:00Z",
  "match": {
    "verdict": "suitable",
    "reasons": ["Только демонстрационная запись"],
    "requirements": [{"requirement": "Требование", "result": "pass", "evidence": "Ссылка на факт кандидата и текст вакансии"}]
  }
}
```

При известном исходном URL добавить original_url для дедупликации. Не придумывать
URL/route/description: пример — только описание схемы. У карточки route=unknown,
match.verdict=unreviewed. Полный ответ провайдера можно сохранить через run-event.
put возвращает is_new; повтор не меняет статус/письмо/согласование. Содержимое
полного текста обновляется, поэтому старый черновик может стать stale.

claims: `[{"text":"утверждение письма","evidence_id":"E1"}]`.
answers: массив фактических ответов; CLI их отдельно не отправляет.
unresolved: массив вопросов, блокирующих отправку.

Auto:

```json
{
  "mode": "auto",
  "auto": {
    "user_authorization": "Реальный текст разрешения пользователя на отправку",
    "profile_hash": "хеш команды profile",
    "expires_at": "дата в будущем ISO 8601, согласованная пользователем",
    "max_attempts_per_utc_day": 3
  }
}
```

Число 3 — пример, не включённое разрешение. begin атомарно проверяет и резервирует
попытку; дневной предел учитывает все попытки (ручные тоже), включая неопределённые.
Новый UTC-день не сбрасывает блок повторного отклика на ту же вакансию.

## Состояния

discovered → draft → approved → submitting → submitted / failed / submission_unknown.
External или недостающие ответы → needs_user. После уточнения — prepare заново;
после ручной внешней отправки — submitted_external. Любой из этапов до отправки
можно dismissed. После отправки: interview / rejected / withdrawn / offer;
из offer: accepted / declined / withdrawn. Status — локальная запись, не действие сервиса.

Схема SQLite v1: runs, jobs, aliases, observations, attempts, dispatches, events.
В attempts UNIQUE(job_id), в dispatches PRIMARY KEY(attempt_id): повтор не проходит
после перезапуска процесса. Сбой после намерения требует ручного разбора.
Нет универсальной транзакции между SQLite и Hirify: невозможно обещать exactly-once
доставку через сеть. Здесь предотвращаются автоматические повторные отправки.

Историю читать через команды. Для резервирования закрыть работающие процессы и
сохранить весь D. Обновление схемы пока не требуется: это первая версия; будущий
апгрейд обязан иметь явную миграцию и резервную копию.
