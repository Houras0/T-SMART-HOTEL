---
name: Server port layout
description: The root .replit server and the API artifact can both target port 8080.
---

The root server and `artifacts/api-server` are separate Express entry points, but they must not run simultaneously on the same port. Shared API behavior belongs in the common library so both entry points stay consistent.

**Why:** Restarting the artifact while the root server is running can leave requests handled by an older process or make the artifact workflow finish because of a port collision.

**How to apply:** Treat the root server as the deployment entry point from `.replit`; use `PORT` when running the artifact separately, and verify which process owns the port before testing routes.