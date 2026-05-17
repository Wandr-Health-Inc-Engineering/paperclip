IMAGE_NAME=scout
COMMIT_TAG=$(shell git rev-parse --short HEAD 2>/dev/null || echo local)
ACR_HOST=wandrapps-c4gwhdhpe3b5haf6.azurecr.io
ACR_NAME=wandrapps
RSC_GROUP=travelwithwandr.com
PORT=3100
COMPOSE_FILE=docker/docker-compose.yml
COMPOSE_PROJECT=scout

.PHONY: help dev test build ensure-pnpm ensure-deps docker-build docker-build-local docker-run docker-stop docker-rm docker-logs docker-restart docker-clean compose-up compose-down compose-logs compose-ps compose-restart service create start destroy stop restart prune push-prod push-dev status shell clean ensure-env

help: ## Show available targets
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

ensure-env: ## Create .env from .env.example when missing
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "Created .env from .env.example — set BETTER_AUTH_SECRET before compose-up"; \
	fi

ensure-pnpm: ## Ensure pnpm is on PATH (activates via corepack when missing)
	@chmod +x scripts/ensure-pnpm.sh
	@./scripts/ensure-pnpm.sh

ensure-deps: ensure-pnpm ## Ensure pnpm and node_modules are ready for local dev
	@./scripts/ensure-pnpm.sh --install

dev: ensure-deps ## Run Scout locally with pnpm (no Docker)
	pnpm dev

test: ensure-deps ## Run the test suite
	pnpm test

build: ensure-deps ## Build workspace packages
	pnpm build

docker-build: ## Build production Docker image (linux/amd64)
	@echo "Building Docker image: $(IMAGE_NAME):$(COMMIT_TAG)"
	docker build --no-cache --platform linux/amd64 \
		-t $(IMAGE_NAME):$(COMMIT_TAG) \
		-t $(IMAGE_NAME):latest \
		-f Dockerfile .
	@echo "Docker image built successfully"

docker-build-local: prune ## Build local Docker image (Dockerfile.local)
	@echo "Building local Docker image: $(IMAGE_NAME):$(COMMIT_TAG)"
	docker build --no-cache \
		-t $(IMAGE_NAME):$(COMMIT_TAG) \
		-t $(IMAGE_NAME):local \
		-f Dockerfile.local .
	@echo "Local Docker image built successfully"

docker-run: ensure-env docker-build-local ## Run app container only (requires DATABASE_URL in .env)
	@echo "Starting Docker container on port $(PORT)..."
	@docker rm -f $(IMAGE_NAME) 2>/dev/null || true
	docker run -d --name $(IMAGE_NAME) \
		-p $(PORT):3100 \
		--env-file .env \
		-v scout-data:/scout \
		$(IMAGE_NAME):$(COMMIT_TAG)
	@echo "scout started on http://localhost:$(PORT)"
	@echo "View logs: make docker-logs"

docker-stop: ## Stop app container
	@echo "Stopping Docker container..."
	docker stop $(IMAGE_NAME) 2>/dev/null || true

docker-rm: docker-stop ## Remove app container
	@echo "Removing Docker container..."
	docker rm $(IMAGE_NAME) 2>/dev/null || true

docker-logs: ## Tail app container logs
	docker logs -f $(IMAGE_NAME)

docker-restart: docker-stop docker-run ## Restart app container

docker-clean: docker-rm ## Remove app container and local tags
	@echo "Cleaning up Docker images..."
	docker rmi $(IMAGE_NAME):$(COMMIT_TAG) $(IMAGE_NAME):latest $(IMAGE_NAME):local 2>/dev/null || true

compose-up: ensure-env ## Start Postgres + Scout via docker compose
	@echo "Starting scout stack (db + server)..."
	SCOUT_DOCKERFILE=Dockerfile.local docker compose -f $(COMPOSE_FILE) -p $(COMPOSE_PROJECT) up -d --build
	@echo "scout: http://localhost:$(PORT)"
	@echo "Logs: make compose-logs"

compose-down: ## Stop docker compose stack
	docker compose -f $(COMPOSE_FILE) -p $(COMPOSE_PROJECT) down

compose-logs: ## Follow docker compose logs
	docker compose -f $(COMPOSE_FILE) -p $(COMPOSE_PROJECT) logs -f

compose-ps: ## Show compose service status
	docker compose -f $(COMPOSE_FILE) -p $(COMPOSE_PROJECT) ps

compose-restart: compose-down compose-up ## Rebuild and restart compose stack

create: docker-build-local ## Alias: build local image

start: compose-up ## Alias: start full local stack

stop: compose-down ## Alias: stop compose stack

destroy: compose-down docker-clean ## Stop stack and remove local images

restart: compose-restart ## Restart compose stack

service: compose-restart ## Full local workflow: rebuild and run db + server

prune: ## Prune Docker builder cache
	docker builder prune -f

push-prod: ## Build and push production image to Azure Container Registry
	@echo "Building and pushing to production ACR..."
	az acr login --name $(ACR_NAME) --resource-group $(RSC_GROUP)
	docker build --no-cache --platform linux/amd64 \
		-f Dockerfile \
		--build-arg INSTALL_AGENT_CLIS=true \
		--tag $(ACR_HOST)/$(IMAGE_NAME):$(COMMIT_TAG) \
		--tag $(ACR_HOST)/$(IMAGE_NAME):latest \
		--push .
	@echo "Pushed to $(ACR_HOST)/$(IMAGE_NAME):$(COMMIT_TAG) and :latest"

push-dev: ## Build and push dev image to Azure Container Registry
	@echo "Building and pushing to dev ACR..."
	az acr login --name $(ACR_NAME) --resource-group $(RSC_GROUP)
	docker build --no-cache --platform linux/amd64 \
		-f Dockerfile.local \
		--tag $(ACR_HOST)/$(IMAGE_NAME):$(COMMIT_TAG) \
		--tag $(ACR_HOST)/$(IMAGE_NAME):dev \
		--push .
	@echo "Pushed to $(ACR_HOST)/$(IMAGE_NAME):$(COMMIT_TAG) and :dev"

status: ## Show running Scout containers
	@docker ps -a --filter name=$(IMAGE_NAME) --filter name=$(COMPOSE_PROJECT) || true
	@$(MAKE) compose-ps 2>/dev/null || true

shell: ## Shell into the running compose server container
	docker compose -f $(COMPOSE_FILE) -p $(COMPOSE_PROJECT) exec server sh

clean: docker-clean compose-down ## Stop containers and remove local images
