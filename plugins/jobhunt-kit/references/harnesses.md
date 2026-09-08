# Установка в агенты

Пути сверены с [каталогом провайдеров Impeccable](https://github.com/pbakaus/impeccable/blob/main/crates/skills/src/providers.rs)
и [его README](https://github.com/pbakaus/impeccable#installation), 2026-09-08.
Для Veto README описывает только глобальный каталог.
Для Copilot глобальный путь `.copilot/skills` соответствует
[документации GitHub](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills).

Установщик копирует переносимый SKILL.md и ресурсы. Он не меняет настройки
доверия, не устанавливает сами приложения и не запускает их. Автоматические тесты
проверяют все пути, комплектность файлов и конфликты; загрузка навыка в каждом
из приложений отдельно не проверена.
