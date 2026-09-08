---
name: jobhunt-kit
description: Set up a candidate profile, review a resume, find suitable jobs through Hirify, prepare applications and track job-search progress. Use when the user wants help with their job search.
---

# Jobhunt Kit

Read the relevant workflow before acting:

- Profile and onboarding: [job-profile](bundle/skills/job-profile/SKILL.md).
- Resume review: [job-resume](bundle/skills/job-resume/SKILL.md).
- Vacancy search: [job-search](bundle/skills/job-search/SKILL.md).
- Application and cover letter: [job-apply](bundle/skills/job-apply/SKILL.md).
- History, status and scheduling: [job-track](bundle/skills/job-track/SKILL.md).

The package root P is the `bundle` folder next to this file. Resolve it from this
file's absolute location, never from the terminal working directory. Candidate
data D belongs in the user's working folder under `local/jobhunt-kit`, never here.
For a global installation, establish the user's working folder before creating data.

On the user's request to initialize a profile, run
`node <P>/scripts/setup.mjs --data <D> --install-cli` to prepare local dependencies.
Then use [CLI commands](bundle/references/cli.md) via `node <P>/scripts/cli.mjs`.
Installation does not authorize applications, account changes or scheduled tasks.
