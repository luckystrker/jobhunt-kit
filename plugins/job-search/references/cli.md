# Команды рабочих сценариев

Установка: `npx github:luckystrker/job-search install [папка]`.
Без пути создаётся `./my-job-search`. Старый `init <папка>` также поддерживается.
Имя `job-search` в npm занято другим пакетом, поэтому для первой установки
использовать именно GitHub-команду.

Из установленной папки: `npx job-search <команда>`. Короткое имя обеспечивается
локальным launcher в node_modules/.bin, создаваемым установщиком. В произвольной
папке использовать `npx github:luckystrker/job-search <команда> --workspace <папка>`:
пакет с коротким именем в npm registry мы не публиковали.

В переносимом плагине доступны те же рабочие команды:
`node <P>/scripts/cli.mjs <команда> --data <D>`. Для работы непосредственно в исходниках:
`node bin/job-search.mjs <команда>`. Тексты JSON писать в файлы, не собирать строкой shell.
Все рабочие команды возвращают JSON; исключения — help и установщик. Ошибка даёт
ненулевой exit. Данные по умолчанию — `<workspace>/local/job-search`.

## Что вынесено из скиллов

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
npx job-search doctor
npx job-search profile init
npx job-search profile show
npx job-search profile check
npx job-search profile save --input local/job-search/materials/profile-draft.json
npx job-search profile confirm --note "Пользователь подтвердил перечисленные факты и условия"
npx job-search resume ./resume.pdf
npx job-search resume check
npx job-search resume reviewed --input local/job-search/materials/review-result.json
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
npx job-search search
npx job-search search start --input run.json
npx job-search search event --input event.json
npx job-search search record --input vacancy.json
npx job-search search finish --input result.json
npx job-search apply prepare --input draft.json
npx job-search apply preview vacancy-slug
npx job-search apply export vacancy-slug
npx job-search apply approve --input approval.json
npx job-search apply begin vacancy-slug
npx job-search apply send --input local/job-search/materials/attempt-UUID.json
npx job-search apply finish --input response.json
npx job-search apply resolve --input verified-outcome.json
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
npx job-search track
npx job-search track show vacancy-slug
npx job-search track status vacancy-slug --input status.json
npx job-search history
npx job-search runs
npx job-search report
npx job-search policy show
npx job-search policy set --input permission.json
npx job-search schedule --input schedule.json
```

status.json: `{"status":"interview","note":"Источник и дата сообщения кандидата"}`.
Состояния и формат permission.json — в storage.md. Команда policy set только
записывает ранее полученное разрешение, не создаёт его.

schedule.json: `{"frequency":"По будням в 09:00","timezone":"Europe/Berlin","mode":"search"}`.
Срок и зона — только пример. Допустимые mode: search/prepare/auto. Результат —
materials/scheduled-search.md, а не включённая задача; auto-разрешение не выдаётся.
Нужен --workspace с установленным шаблоном, чтобы prompt не ссылался на временный
кеш npx. Планировщик выбирает агент по явному запросу пользователя.
