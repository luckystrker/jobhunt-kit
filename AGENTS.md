# Job Search template

This repository is a reusable template, not the owner's job search. Do not populate a
real profile, call Hirify account/search APIs, apply, or schedule tasks while developing
the template. Use temporary directories and clearly fictional fixtures for validation.

When the user requests a job search, initialize their local data through job-profile.
Keep personal files under local/ (gitignored), never in plugins/ or examples/.

The portable plugin is plugins/job-search. For job-search use, read the relevant entry:

- skills/job-profile/SKILL.md — initialize/update candidate and reusable answers.
- skills/job-resume/SKILL.md — evidence-based resume review.
- skills/job-search/SKILL.md — bounded Hirify search and matching.
- skills/job-apply/SKILL.md — cover letter, approval, sending, manual handoff.
- skills/job-track/SKILL.md — local statuses, reports and optional schedule setup.

All paths above are relative to plugins/job-search. Shared rules are in
references/workflow.md. SQLite is authoritative for vacancy/application history;
profile.json is authoritative for candidate facts. Markdown summaries are derived.

Use `npm test` for offline checks. Never test sending on real vacancies. Do not push
candidate files. Installing a plugin does not authorize applications or account changes.
