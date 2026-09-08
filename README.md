# Jobhunt Kit

```sh
npx jobhunt-kit install
```

Поиск работы вместе с AI-агентом: профиль кандидата, проверка резюме, подбор вакансий
через Hirify, сопроводительные письма и история откликов.

Нужны **Node.js 24+ и агент с поддержкой навыков**. Установщик предложит выбрать
агентов и область установки: рабочая папка или глобально для пользователя.
При установке в рабочую папку он создаст `my-jobhunt`, установит зависимости
и подключит навык к выбранным агентам. Другой путь: `install ./my-folder`.

## Начало работы

1. Откройте `my-jobhunt` в агенте.
2. Напишите: **«Инициализируй мой профиль поиска работы»**. Агент запросит резюме,
   уточнит опыт, предпочтения и условия поиска.
3. В терминале этой папки выполните `npm run hirify -- login` для входа в Hirify.
4. После подтверждения профиля попросите: **«Найди до пяти новых подходящих вакансий»**.
5. Выберите вакансию и попросите подготовить отклик. Перед отправкой агент запросит
   согласование.

Страны, роли и формат занятости задаются в профиле. Для независимых профилей
используйте отдельные рабочие папки.

## Возможности

| Навык | Что делает |
|---|---|
| [job-profile](plugins/jobhunt-kit/skills/job-profile/SKILL.md) | Собирает профиль, предпочтения и ответы на вопросы анкет |
| [job-resume](plugins/jobhunt-kit/skills/job-resume/SKILL.md) | Проверяет содержание, читаемость и соответствие резюме выбранным ролям |
| [job-search](plugins/jobhunt-kit/skills/job-search/SKILL.md) | Подбирает до пяти новых подходящих вакансий за запуск и объясняет выбор |
| [job-apply](plugins/jobhunt-kit/skills/job-apply/SKILL.md) | Готовит письмо и отправляет согласованный отклик через Hirify |
| [job-track](plugins/jobhunt-kit/skills/job-track/SKILL.md) | Ведёт историю, обновляет статусы и помогает настроить поиск по расписанию |

По умолчанию каждый отклик согласуется отдельно. Автоматическую отправку можно
включить с ограничением срока и количества откликов. Для внешних форм агент готовит
ссылку, письмо и ответы, а отправку выполняете вы.

При отправке через Hirify используется выбранный профиль сервиса. Локальный файл
резюме автоматически туда не загружается. О приглашениях и ответах рекрутеров
сообщайте агенту, чтобы он обновил статусы.

## Команды

Запускайте из установленной папки:

```sh
npx jobhunt-kit doctor
npx jobhunt-kit profile init
npx jobhunt-kit resume ./resume.pdf
npx jobhunt-kit profile check
npx jobhunt-kit search
npx jobhunt-kit track
npx jobhunt-kit report
```

`resume` извлекает текст PDF, DOCX, TXT или Markdown и готовит материалы для проверки
агентом. `search` собирает контекст для агента, который выполняет поиск и оценивает
вакансии. Команды также позволяют управлять профилем, черновиками и статусами.

[Справочник команд](plugins/jobhunt-kit/references/cli.md).

## Локальные данные

Профиль, резюме и история хранятся в `local/jobhunt-kit/`:

| Путь | Содержимое |
|---|---|
| `profile.json` | Факты, предпочтения и ответы кандидата |
| `policy.json` | Условия поиска и согласования откликов |
| `history.sqlite` | История поисков, вакансий и откликов |
| `resumes/` | Версии резюме |
| `materials/` | Письма, ответы и материалы проверки |
| `reports/latest.md` | Сводный отчёт |

Папка `local/` исключена из Git. Храните личные файлы в ней; для резервной копии
сохраняйте всю папку при остановленных процессах. Данные на диске не зашифрованы.

## Выбор агентов

Без интерактивных вопросов:

```sh
npx jobhunt-kit install --agents codex,cursor,gemini
npx jobhunt-kit install --agents all
npx jobhunt-kit install --providers opencode,pi --scope global
npx jobhunt-kit agents
```

В режиме `project` навык устанавливается в созданную рабочую папку,
в режиме `global` — в домашнюю папку пользователя.

| Агент | Значение `--agents` | Рабочая папка | Глобально (от `~`) |
|---|---|---|---|
| Codex | `codex` | `.agents/skills/` | `.agents/skills/` |
| Claude Code | `claude` | `.claude/skills/` | `.claude/skills/` |
| Cursor | `cursor` | `.cursor/skills/` | `.cursor/skills/` |
| Gemini CLI | `gemini` | `.gemini/skills/` | `.gemini/skills/` |
| GitHub Copilot | `github` | `.github/skills/` | `.copilot/skills/` |
| OpenCode | `opencode` | `.opencode/skills/` | `.config/opencode/skills/` |
| Antigravity | `antigravity` | `.agent/skills/` | `.gemini/config/skills/` |
| Pi | `pi` | `.pi/skills/` | `.pi/agent/skills/` |
| Grok Build | `grok` | `.grok/skills/` | `.grok/skills/` |
| Hermes Agent | `hermes` | `.hermes/skills/` | `.hermes/skills/` |
| DeepSeek Harness | `dsh` | `.dsh/skills/` | `.dsh/skills/` |
| Kiro | `kiro` | `.kiro/skills/` | `.kiro/skills/` |
| Qoder | `qoder` | `.qoder/skills/` | `.qoder/skills/` |
| Trae | `trae` | `.trae/skills/` | `.trae/skills/` |
| Trae CN | `trae-cn` | `.trae-cn/skills/` | `.trae-cn/skills/` |
| Rovo Dev | `rovo-dev` | `.rovodev/skills/` | `.rovodev/skills/` |
| Mistral Vibe | `vibe` | `.vibe/skills/` | `.vibe/skills/` |
| Veto | `veto` | — | `.veto/skills/` |

В каждом каталоге создаётся отдельная папка `jobhunt-kit` с навыком и его ресурсами.
`--agents all` выбирает всех агентов для указанной области; Veto доступен только
глобально. `--providers` — синоним `--agents`. Можно использовать имена
`copilot`, `claude-code`, `deepseek` и `grok-build`.

OpenCode учитывает `OPENCODE_CONFIG_DIR` и `XDG_CONFIG_HOME`; Hermes и DeepSeek —
`HERMES_HOME` и `DSH_HOME`. Глобальные пути должны находиться в домашней папке.
При установке Hermes в проект выполните `hermes skills trust` в рабочей папке.
В остальных агентах при необходимости включите поддержку навыков и доверие к проекту.

После установки откройте новую сессию и попросите использовать **jobhunt-kit**.
В Claude Code можно вызвать `/jobhunt-kit`. Отдельные команды marketplace
и `--plugin-dir` для этого способа не нужны.

`--yes` выбирает обнаруженных агентов (или Codex и Claude Code, если ничего не обнаружено)
и область `project`. Обнаружение использует каталоги агентов, а не запускает их.
Для скриптов задавайте `--agents` и `--scope` явно.

Установщик сохраняет существующие файлы: при различиях останавливается до копирования.
Для установки новой версии используйте новую папку. `init <папка>` по-прежнему
создаёт только шаблон без подключения навыков.

## Разработка

```sh
npm ci --ignore-scripts
npm test
npm run check
```

Тесты работают с вымышленными данными и не отправляют реальные отклики.

Руководства: [формат данных](plugins/jobhunt-kit/references/storage.md),
[проверка резюме](plugins/jobhunt-kit/references/resume-guidance.md),
[сопроводительные письма](plugins/jobhunt-kit/references/cover-guidance.md).

Автор этого шаблона никак не аффилирован с Hirify.
