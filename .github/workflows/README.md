# Workflow templates

The seven `deploy-*.yml.example` files are inactive templates. Each watches exactly one canonical app file on `main` and supports manual dispatch. They contain a fail-fast placeholder, not a working deployment.

Follow [deployment setup](../../docs/deployment.md), replace the placeholder, then rename the relevant template to `.yml`. Activate one artifact at a time, starting with Drive.
