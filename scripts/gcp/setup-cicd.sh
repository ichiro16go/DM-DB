#!/usr/bin/env bash
# One-time setup so GitHub Actions can deploy on every push to main (no service-account keys).
#
#   PROJECT_ID=my-project ./scripts/gcp/setup-cicd.sh
#
# Run it after scripts/gcp/setup.sh has deployed once (it creates the service, jobs and their accounts).
# Creates:
#   - Workload Identity pool "github-actions" + OIDC provider "github", accepting ONLY this repository's
#     main branch
#   - service account dm-card-db-deployer: push images, deploy the service / update the jobs, act as their
#     runtime accounts. Nothing else (no data, no secrets).
# Then stores the three values the workflow needs as GitHub repository variables (via gh, if logged in).
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-northeast1}"
REPO="${REPO:-dm-card-db}"
POOL="github-actions"
PROVIDER="github"
DEPLOYER="dm-card-db-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
WEB_SA="dm-card-db-web@${PROJECT_ID}.iam.gserviceaccount.com"
JOB_SA="dm-card-db-job@${PROJECT_ID}.iam.gserviceaccount.com"
# owner/repo from the git remote (https://github.com/owner/repo(.git) or git@github.com:owner/repo.git)
GH_REPO="${GH_REPO:-$(git config --get remote.origin.url | sed -E 's#(\.git)?$##; s#^.*github\.com[:/]##')}"
[[ "$GH_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "could not tell the GitHub repo; set GH_REPO=owner/repo" >&2; exit 1; }

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"

step "Enable APIs"
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com

step "Workload Identity pool/provider for ${GH_REPO} (main branch only)"
gcloud iam workload-identity-pools describe "$POOL" --location global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location global --display-name "GitHub Actions"
CONDITION="assertion.repository=='${GH_REPO}' && assertion.ref=='refs/heads/main'"
if gcloud iam workload-identity-pools providers describe "$PROVIDER" --location global --workload-identity-pool "$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" --location global --workload-identity-pool "$POOL" \
    --attribute-condition "$CONDITION"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location global --workload-identity-pool "$POOL" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "$CONDITION"
fi
PROVIDER_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

step "Deployer service account (least privilege)"
gcloud iam service-accounts describe "$DEPLOYER" >/dev/null 2>&1 ||
  gcloud iam service-accounts create dm-card-db-deployer --display-name "dm-card-db deployer (GitHub Actions)"
gcloud artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" \
  --member "serviceAccount:${DEPLOYER}" --role roles/artifactregistry.writer >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${DEPLOYER}" --role roles/run.developer --condition None >/dev/null
for sa in "$WEB_SA" "$JOB_SA"; do
  gcloud iam service-accounts add-iam-policy-binding "$sa" --member "serviceAccount:${DEPLOYER}" --role roles/iam.serviceAccountUser >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GH_REPO}" >/dev/null

step "GitHub repository variables"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh variable set GCP_PROJECT_ID --repo "$GH_REPO" --body "$PROJECT_ID"
  gh variable set GCP_REGION --repo "$GH_REPO" --body "$REGION"
  gh variable set GCP_WIF_PROVIDER --repo "$GH_REPO" --body "$PROVIDER_NAME"
  gh variable set GCP_DEPLOYER_SA --repo "$GH_REPO" --body "$DEPLOYER"
  echo "set. Every push to main now deploys; you can also run it from the Actions tab (ci → Run workflow)."
else
  cat <<EOF
gh is not logged in. Add these in GitHub: Settings → Secrets and variables → Actions → Variables
  GCP_PROJECT_ID   = ${PROJECT_ID}
  GCP_REGION       = ${REGION}
  GCP_WIF_PROVIDER = ${PROVIDER_NAME}
  GCP_DEPLOYER_SA  = ${DEPLOYER}
EOF
fi
