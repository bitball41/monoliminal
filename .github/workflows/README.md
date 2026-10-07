# GitHub Actions

- `deploy-*.yml`: seven file-specific push/manual deployment entry points.
- `_deploy-storage.yml`: shared validation, tests, serialization, deployment and report upload.
- `rollback.yml`: manual restoration from an app's Storage history.
- `check-deployments.yml`: source/manifest checks and recovery tests on PRs and machinery changes, without deployment secrets.

Add the two secrets described in [deployment setup](../../docs/deployment.md). Manual buttons default to dry runs. Pushes changing app HTML publish after validation.
