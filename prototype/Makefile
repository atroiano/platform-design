RELEASE ?= 0.2.0
IMAGE ?= hivear-draft:$(RELEASE)
image:     ## build a release image: make image RELEASE=0.2.0
	docker build --build-arg RELEASE=$(RELEASE) -t $(IMAGE) .

up: image  ## first install: migrate, start blue, load sample buckets
	deploy/bluegreen.sh init $(IMAGE)
	docker compose --env-file deploy/state.env exec -T app_blue python manage.py seed_demo

deploy: image  ## bring a release up as the idle color and test it: make deploy RELEASE=0.2.0
	deploy/bluegreen.sh deploy $(IMAGE)

cutover:   ## send live traffic to the idle color
	deploy/bluegreen.sh cutover

rollback:  ## send live traffic back
	deploy/bluegreen.sh rollback

finalize:  ## stop the previous color
	deploy/bluegreen.sh finalize

status:    ## show both colors
	deploy/bluegreen.sh status

down:      ## stop everything, keep the data volume
	docker compose --profile blue --profile green --profile tools down

test: image  ## run the test suite against the compose PostgreSQL
	docker compose up -d db
	TARGET_IMAGE=$(IMAGE) docker compose --profile tools run --rm release pytest -q

check-migrations: image  ## the SHARED-0010 migration compatibility check
	docker run --rm $(IMAGE) python manage.py check_migrations

openapi:   ## export the API's OpenAPI document for frontend development
	docker build -q --target backend -t hivear-draft-backend:dev . > /dev/null
	docker run --rm hivear-draft-backend:dev cat /tmp/openapi.json > frontend/openapi.json

compat:    ## the previous release's tests against this release's schema: make compat PREVIOUS=hivear-draft:0.1.2
	deploy/compat_test.sh $(PREVIOUS) $(IMAGE)

drill:     ## end-to-end blue-green rehearsal on a throwaway database
	deploy/drill.sh

.PHONY: compat openapi image up deploy cutover rollback finalize status down test check-migrations drill
