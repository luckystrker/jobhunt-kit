# Команды рабочих сценариев

Установка: `npx jobhunt-kit install [папка]` с выбором Codex/Claude Code и области.
Без вопросов: `npx jobhunt-kit install --agents codex,claude --scope project`.
Глобально: `npx jobhunt-kit install --agents claude --scope global` (без пути).
В глобальном режиме устанавливаются только навыки; зависимости и данные создаёт
агент в рабочей папке при инициализации профиля.
Без пути создаётся `./my-jobhunt`. Старый `init <папка>` также поддерживается.
Из установленной папки: `npx jobhunt-kit <команда>`.
Из другой папки: `npx jobhunt-kit <команда> --workspace <папка>`.

В переносимом плагине доступны те же рабочие команды:
`node <P>/scripts/cli.mjs <команда> --data <D>`. Для работы непосредственно в исходниках:
`node bin/jobhunt-kit.mjs <команда>`. Тексты JSON писать в файлы, не собирать строкой shell.
Все рабочие команды возвращают JSON; исключения — help и установщик. Ошибка даёт
ненулевой exit. Данные по умолчанию — `<workspace>/local/jobhunt-kit`.

## Команды и работа агента

| Скилл | Детерминированная часть | Что остаётся у агента |
|---|---|---|
| job-profile | Пустая анкета, проверка структуры/ссылок evidence/зарплаты, сохранение, сброс и запись подтверждения | Интервью, интерпретация опыта, уточнение противоречий, получение настоящего согласия |
| job-resume | Копия по SHA-256, извлечение PDF/DOCX/TXT/MD, простые проверки текста, сохранение отчёта, запись завершённой проверки | Визуальная оценка, истинность фактов, соответствие роли и содержательные правки |
| job-search | Сбор профиля, бюджетов и известных вакансий; журнал запусков/результатов, запрет второго активного запуска через CLI | Актуальные фильтры Hirify, preview, живой поиск, оценка требований и ранжирование |
| job-apply | Снимок черновика, экспорт текста/ответов, согласование, резервирование и однократный вызов CLI, запись исхода | Написание письма из фактов, проверка живого профиля/квоты, получение разрешения, разбор ответа сервиса |
| job-track | Списки/история/статусы/Markdown; заполнение prompt для расписания | Интерпретация сообщения кандидата, создание задачи в планировщике после запроса |

Технические функции: `profile.mjs`, `resume.mjs`, `extract-resume.mjs`, `commands.mjs`;
история и защита отправки переиспользуют `tracker.mjs` и `send-packet.mjs`.
Команды не запускают встроенную LLM и не требуют отдельного AI API-ключа.

## Профиль и резюме

```text
npx jobhunt-kit doctor
npx jobhunt-kit profile init
npx jobhunt-kit profile show
npx jobhunt-kit profile check
npx jobhunt-kit profile save --input local/jobhunt-kit/materials/profile-draft.json
npx jobhunt-kit profile confirm --note "Пользователь подтвердил перечисленные факты и условия"
npx jobhunt-kit resume ./resume.pdf
npx jobhunt-kit resume check
npx jobhunt-kit resume reviewed --input local/jobhunt-kit/materials/review-result.json
```

`doctor` проверяет только локальное окружение; не читает аккаунт и не создаёт профиль.
`profile save` принимает полный профиль, проверяет структуру и сбрасывает confirmed_at.
Сам факт прохождения валидации не подтверждает биографию. `confirm` использовать
только после реального подтверждения; текст в примере не заменяет ответ пользователя.

`resume <file>` сохраняет копию в resumes/<sha256>.<ext>, привязывает её к профилю
и запускает механические проверки. Новая версия сбрасывает подтверждение профиля.
PDF извлекается через pdf-parse, DOCX — mammoth, TXT/MD — UTF-8; DOC/RTF сначала
нужно экспортировать в поддерживаемый формат. OCR и визуальный рендер не выполняются.
PDF/DOCX обрабатываются локально в дочернем процессе с тайм-аутом 60 секунд.

В materials/resume-<sha256>/ появляются checks.json, text.txt (если извлечение удалось)
и review.md для агента. Уже заполненный review.md не перезаписывается.
Проверки email/заголовка — простые эвристики, а не ATS-тест. Даже успешное извлечение
не устанавливает ready. Ошибка парсера записывается в findings, сохраняя файл и
диагностику; агент проверяет поле text_extraction, а не только exit процесса.

Формат review-result.json после фактической проверки агентом:

```json
{
  "sha256": "хеш проверенной версии файла",
  "status": "ready",
  "checks": { "text": "pass", "visual": "pass", "facts": "pass" },
  "evidence": "Что и каким инструментом проверено; ссылка на отчёт и подтверждение кандидата"
}
```

Можно записать needs_changes. Ready требует всех трёх checks=pass и совпадающего
хеша; запись не заменяет сами проверки. После изменения review потребуется profile confirm.

## Поиск и отклики

```text
npx jobhunt-kit search
npx jobhunt-kit search start --input run.json
npx jobhunt-kit search event --input event.json
npx jobhunt-kit search record --input vacancy.json
npx jobhunt-kit search finish --input result.json
npx jobhunt-kit apply prepare --input draft.json
npx jobhunt-kit apply preview vacancy-slug
npx jobhunt-kit apply export vacancy-slug
npx jobhunt-kit apply approve --input approval.json
npx jobhunt-kit apply begin vacancy-slug
npx jobhunt-kit apply send --input local/jobhunt-kit/materials/attempt-UUID.json
npx jobhunt-kit apply finish --input response.json
npx jobhunt-kit apply resolve --input verified-outcome.json
```

`search` готовит search-context.json и search-task.md для агента; **живой поиск ещё
не выполнен**. Это явно указано в выводе. Форматы записей совпадают с
[storage.md](storage.md): start=run-start, event=run-event, record=put, finish=run-finish.
Чтения/preview/поиск Hirify выполняет агент по job-search и сохраняет их результаты.

`apply export` сохраняет текст письма, ответы, снимок и handoff.md в отдельную
папку версии черновика. `begin` сохраняет пакет по уникальному attempt_id и отдаёт
packet_path. `send` — единственная рабочая команда этого CLI, вызывающая отправку;
она не получает новое разрешение сама и не обходит проверки трекера.
Перед ней агент проверяет квоту и серверный профиль. После неё агент разбирает
достоверный ответ и вызывает finish. При аварии повторная отправка блокируется.

## История, политика и расписание

```text
npx jobhunt-kit track
npx jobhunt-kit track show vacancy-slug
npx jobhunt-kit track status vacancy-slug --input status.json
npx jobhunt-kit history
npx jobhunt-kit runs
npx jobhunt-kit report
npx jobhunt-kit policy show
npx jobhunt-kit policy set --input permission.json
npx jobhunt-kit schedule --input schedule.json
```

status.json: `{"status":"interview","note":"Источник и дата сообщения кандидата"}`.
Состояния и формат permission.json — в storage.md. Команда policy set только
записывает ранее полученное разрешение, не создаёт его.

schedule.json: `{"frequency":"По будням в 09:00","timezone":"Europe/Berlin","mode":"search"}`.
Срок и зона — только пример. Допустимые mode: search/prepare/auto. Результат —
materials/scheduled-search.md, а не включённая задача; auto-разрешение не выдаётся.
Нужен --workspace с установленным шаблоном, чтобы prompt не ссылался на временный
кеш npx. Планировщик выбирает агент по явному запросу пользователя.
