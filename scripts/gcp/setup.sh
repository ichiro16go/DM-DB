#!/usr/bin/env bash
# One-time (re-runnable) setup + deploy of DM Card DB on Google Cloud.
# Everything is idempotent: re-running updates the service/job to the current code.
#
#   PROJECT_ID=my-project ./scripts/gcp/setup.sh
#
# Optional overrides: REGION, BUCKET, SERVICE, JOB, AUTH_USER, SCHEDULE.
# See docs/deploy-gcp.md for what each step does and why.
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-northeast1}"
BUCKET="${BUCKET:-${PROJECT_ID}-dm-card-db}"
SERVICE="${SERVICE:-dm-card-db}"
JOB="${JOB:-dm-card-db-update}"
REPO="${REPO:-dm-card-db}"
AUTH_USER="${AUTH_USER:-dm}"
SCHEDULE="${SCHEDULE:-17 4 * * 1}"   # every Monday 04:17 JST
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/app:$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
STORE="gs://${BUCKET}/data"

WEB_SA="dm-card-db-web@${PROJECT_ID}.iam.gserviceaccount.com"
JOB_SA="dm-card-db-job@${PROJECT_ID}.iam.gserviceaccount.com"
SCHED_SA="dm-card-db-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
gcloud config set project "$PROJECT_ID" >/dev/null

step "Enable APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com

step "Bucket ${BUCKET} (data store: published DB, crawl cache, history)"
if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
fi
cat > /tmp/dm-lifecycle.json <<'JSON'
{ "rule": [
  { "action": { "type": "Delete" }, "condition": { "age": 90, "matchesPrefix": ["data/history/", "data/rejected/"] } }
] }
JSON
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file=/tmp/dm-lifecycle.json

step "Service accounts (least privilege)"
for sa in dm-card-db-web dm-card-db-job dm-card-db-scheduler; do
  gcloud iam service-accounts describe "${sa}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$sa" --display-name "$sa"
done
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member "serviceAccount:${WEB_SA}" --role roles/storage.objectViewer >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member "serviceAccount:${JOB_SA}" --role roles/storage.objectAdmin >/dev/null

step "Secrets (generated once; read them with: gcloud secrets versions access latest --secret=...)"
for s in dm-auth-password dm-api-token; do
  if ! gcloud secrets describe "$s" >/dev/null 2>&1; then
    gcloud secrets create "$s" --replication-policy automatic
    openssl rand -base64 30 | tr -d '\n/+=' | gcloud secrets versions add "$s" --data-file=-
  fi
  gcloud secrets add-iam-policy-binding "$s" --member "serviceAccount:${WEB_SA}" --role roles/secretmanager.secretAccessor >/dev/null
done

step "Artifact Registry + image build (${IMAGE})"
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION"
gcloud builds submit --tag "$IMAGE" .

step "Seed data if the store is empty"
if ! gcloud storage objects describe "${STORE}/dm.sqlite" >/dev/null 2>&1; then
  if [[ -f data/dm.sqlite && -d data/raw ]]; then
    tar -czf /tmp/dm-raw.tar.gz -C data raw
    gcloud storage cp /tmp/dm-raw.tar.gz "${STORE}/raw.tar.gz"
    gcloud storage cp data/dm.sqlite "${STORE}/dm.sqlite"
    echo "seeded from local data/ (no 1.5h first crawl needed)"
  else
    echo "no local data/: the first job run below does a full crawl (~1.5h); the service starts once it publishes"
  fi
fi

step "Update job ${JOB}"
gcloud run jobs deploy "$JOB" --image "$IMAGE" --region "$REGION" \
  --service-account "$JOB_SA" \
  --command node --args=--enable-source-maps,dist/jobs/update.js \
  --set-env-vars "DM_DATA_STORE=${STORE},DM_CRAWL_CONCURRENCY=4,DM_REVISION=${IMAGE##*:}" \
  --memory 2Gi --cpu 1 --task-timeout 3h --max-retries 1

step "Weekly schedule"
gcloud run jobs add-iam-policy-binding "$JOB" --region "$REGION" --member "serviceAccount:${SCHED_SA}" --role roles/run.invoker >/dev/null
JOB_URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB}:run"
if gcloud scheduler jobs describe "${JOB}-weekly" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB}-weekly" --location "$REGION" --schedule "$SCHEDULE" --time-zone Asia/Tokyo \
    --uri "$JOB_URI" --http-method POST --oauth-service-account-email "$SCHED_SA"
else
  gcloud scheduler jobs create http "${JOB}-weekly" --location "$REGION" --schedule "$SCHEDULE" --time-zone Asia/Tokyo \
    --uri "$JOB_URI" --http-method POST --oauth-service-account-email "$SCHED_SA"
fi

if ! gcloud storage objects describe "${STORE}/dm.sqlite" >/dev/null 2>&1; then
  step "First full crawl (waits ~1.5h)"
  gcloud run jobs execute "$JOB" --region "$REGION" --wait
fi

step "Service ${SERVICE}"
# --allow-unauthenticated lets the browser reach the app; the app itself enforces Basic auth / tokens
# and refuses to start on Cloud Run without them (see src/server/config.ts).
gcloud run deploy "$SERVICE" --image "$IMAGE" --region "$REGION" \
  --service-account "$WEB_SA" --allow-unauthenticated \
  --set-env-vars "DM_DATA_STORE=${STORE},DM_AUTH_USER=${AUTH_USER},DM_DB_REFRESH_SECONDS=600" \
  --set-secrets "DM_AUTH_PASSWORD=dm-auth-password:latest,DM_API_TOKEN=dm-api-token:latest" \
  --memory 1Gi --cpu 1 --min-instances 0 --max-instances 2 --concurrency 40 --timeout 60

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
step "Done"
cat <<EOF
URL:        ${URL}
Login:      user "${AUTH_USER}", password: gcloud secrets versions access latest --secret=dm-auth-password
MCP:        claude mcp add --transport http dm-cards ${URL}/mcp --header "Authorization: Bearer \$(gcloud secrets versions access latest --secret=dm-api-token)"
Update now: gcloud run jobs execute ${JOB} --region ${REGION}
EOF
