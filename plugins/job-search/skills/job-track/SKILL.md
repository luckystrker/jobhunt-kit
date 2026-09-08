---
name: job-track
description: Show local job-search history and reports, record user-reported application statuses, resolve uncertain submissions, or prepare an explicitly requested recurring search. Does not read email or send recruiter follow-ups.
---

# История и дальнейшие шаги

Прочитать [workflow](../../references/workflow.md) и [storage](../../references/storage.md).
Для обзора выполнить list, runs, history и report; для вакансии — show <slug>.
Показывать статус, дату, основания, источник обновления и следующий шаг.

Новые сообщения пользователя об интервью/отказе/оффере записывать через status с
note (содержание, источник, дата). Не заявлять, что Hirify сам сообщил эти статусы.
Внешний отклик отметить submitted_external только после подтверждения пользователя.
Для submitting/submission_unknown использовать resolve при доказанном исходе,
не предлагать автоматический повтор. Отказ работодателя — rejected, ошибка отправки — failed.

Если пользователь явно просит регулярный поиск, адаптировать
[шаблон расписания](../../templates/scheduled-search.md), уточнив частоту/часовой пояс
и доступность машины. Создать задачу штатным инструментом агента, если он доступен.
Если инструмента нет — сохранить готовый prompt и инструкции, честно сказать, что
задача не создана. В Codex использовать automation_update; в другой среде её scheduler.
Не создавать расписание при установке шаблона. Параллельные поиски по одному D не запускать.

Ничего не отправлять работодателям из скилла трекинга. Отмена локального статуса
не отзывает отправленное через Hirify заявление. Напоминания — только пользователю.
