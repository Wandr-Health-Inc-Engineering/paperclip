data "azurerm_client_config" "current" {}

data "azurerm_resource_group" "rg" {
  name = var.environment == "prod" ? var.prod_backend : var.dev_backend
}

data "azurerm_key_vault" "admin_kv" {
  name                = "wandrhealth-admin-keys"
  resource_group_name = var.main_resouce_group_name
}

data "azurerm_container_registry" "acr" {
  name                = "wandrapps"
  resource_group_name = var.main_resouce_group_name
}

data "azurerm_container_app_environment" "env" {
  name                = var.environment == "prod" ? var.prod_container_env : var.dev_container_env
  resource_group_name = data.azurerm_resource_group.rg.name
}

data "azurerm_key_vault_secret" "better_auth_secret" {
  count        = var.better_auth_secret_kv_name != "" ? 1 : 0
  name         = var.better_auth_secret_kv_name
  key_vault_id = data.azurerm_key_vault.admin_kv.id
}

data "azurerm_key_vault_secret" "anthropic_api_key" {
  count        = var.anthropic_api_key_kv_name != "" ? 1 : 0
  name         = var.anthropic_api_key_kv_name
  key_vault_id = data.azurerm_key_vault.admin_kv.id
}

data "azurerm_key_vault_secret" "openai_api_key" {
  count        = var.openai_api_key_kv_name != "" ? 1 : 0
  name         = var.openai_api_key_kv_name
  key_vault_id = data.azurerm_key_vault.admin_kv.id
}

data "azurerm_key_vault_secret" "github_token" {
  count        = var.github_token_kv_name != "" ? 1 : 0
  name         = var.github_token_kv_name
  key_vault_id = data.azurerm_key_vault.admin_kv.id
}

resource "random_password" "postgres_admin" {
  length  = 32
  special = true
}

resource "random_password" "better_auth_secret" {
  count   = var.better_auth_secret_kv_name == "" ? 1 : 0
  length  = 48
  special = true
}

resource "random_string" "storage_suffix" {
  length  = 6
  special = false
  upper   = false
}

locals {
  container_app_name   = "${var.environment}-scout"
  postgres_server_name = var.postgres_server_name != "" ? var.postgres_server_name : "scout-db-${var.environment}"
  storage_account_name = substr(replace("scout${var.environment}${random_string.storage_suffix.result}", "-", ""), 0, 24)
  public_url           = var.scout_public_url != "" ? var.scout_public_url : "https://${local.container_app_name}.${data.azurerm_container_app_environment.env.default_domain}"
  database_url         = "postgresql://${var.postgres_admin_username}:${urlencode(random_password.postgres_admin.result)}@${azurerm_postgresql_flexible_server.db.fqdn}:5432/${azurerm_postgresql_flexible_server_database.db.name}?sslmode=require"
  better_auth_secret   = var.better_auth_secret_kv_name != "" ? data.azurerm_key_vault_secret.better_auth_secret[0].value : random_password.better_auth_secret[0].result
  min_replicas         = var.environment == "prod" ? var.prod_min_replicas : var.dev_min_replicas
  max_replicas         = var.environment == "prod" ? var.prod_max_replicas : var.dev_max_replicas
  container_cpu        = var.environment == "prod" ? var.prod_container_cpu : var.dev_container_cpu
  container_memory     = var.environment == "prod" ? var.prod_container_memory : var.dev_container_memory
  image_tag            = var.environment == "prod" ? var.prod_tag : var.dev_tag
}

resource "azurerm_user_assigned_identity" "scout" {
  name                = "scout-identity-${var.environment}"
  resource_group_name = data.azurerm_resource_group.rg.name
  location            = data.azurerm_resource_group.rg.location
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = data.azurerm_container_registry.acr.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.scout.principal_id
}

resource "azurerm_role_assignment" "key_vault_secrets_user" {
  scope                = data.azurerm_key_vault.admin_kv.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.scout.principal_id
}

resource "azurerm_postgresql_flexible_server" "db" {
  name                         = local.postgres_server_name
  resource_group_name          = data.azurerm_resource_group.rg.name
  location                     = var.postgres_location
  version                      = var.postgres_version
  administrator_login          = var.postgres_admin_username
  administrator_password       = random_password.postgres_admin.result
  sku_name                     = var.postgres_sku_name
  storage_mb                   = var.postgres_storage_mb
  backup_retention_days        = var.environment == "prod" ? 14 : 7
  geo_redundant_backup_enabled = var.environment == "prod"

  tags = {
    environment = var.environment
    service     = "scout"
  }
}

resource "azurerm_postgresql_flexible_server_database" "db" {
  name      = var.postgres_database_name
  server_id = azurerm_postgresql_flexible_server.db.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_azure_services" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.db.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_admin_ip" {
  count            = var.admin_firewall_ip != "" ? 1 : 0
  name             = "AllowAdminIP"
  server_id        = azurerm_postgresql_flexible_server.db.id
  start_ip_address = var.admin_firewall_ip
  end_ip_address   = var.admin_firewall_ip
}

resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.db.id
  value     = "PG_TRGM"
}

resource "azurerm_storage_account" "scout" {
  name                     = local.storage_account_name
  resource_group_name      = data.azurerm_resource_group.rg.name
  location                 = data.azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"

  tags = {
    environment = var.environment
    service     = "scout"
  }
}

resource "azurerm_storage_share" "scout_data" {
  name                 = "scout-data"
  storage_account_name = azurerm_storage_account.scout.name
  quota                = var.file_share_quota_gb
}

resource "azurerm_container_app_environment_storage" "scout_data" {
  name                         = "scout-data-${var.environment}"
  container_app_environment_id = data.azurerm_container_app_environment.env.id
  account_name                 = azurerm_storage_account.scout.name
  share_name                   = azurerm_storage_share.scout_data.name
  access_key                   = azurerm_storage_account.scout.primary_access_key
  access_mode                  = "ReadWrite"
}

resource "azurerm_log_analytics_workspace" "logs" {
  name                = "scout-logs-${var.environment}"
  resource_group_name = data.azurerm_resource_group.rg.name
  location            = data.azurerm_resource_group.rg.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "time_sleep" "wait_for_roles" {
  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_role_assignment.key_vault_secrets_user,
    azurerm_postgresql_flexible_server_database.db,
    azurerm_postgresql_flexible_server_firewall_rule.allow_azure_services,
  ]

  create_duration = "30s"
}

resource "azurerm_container_app" "app" {
  depends_on = [time_sleep.wait_for_roles]

  name                         = local.container_app_name
  container_app_environment_id = data.azurerm_container_app_environment.env.id
  resource_group_name          = data.azurerm_resource_group.rg.name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.scout.id]
  }

  registry {
    server   = data.azurerm_container_registry.acr.login_server
    identity = azurerm_user_assigned_identity.scout.id
  }

  template {
    min_replicas = local.min_replicas
    max_replicas = local.max_replicas

    volume {
      name         = "scout-data"
      storage_type = "AzureFile"
      storage_name = azurerm_container_app_environment_storage.scout_data.name
    }

    container {
      name   = "scout"
      image  = "${data.azurerm_container_registry.acr.login_server}/${var.container_image_name}:${local.image_tag}"
      cpu    = local.container_cpu
      memory = local.container_memory

      volume_mounts {
        name = "scout-data"
        path = "/paperclip"
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "HOST"
        value = "0.0.0.0"
      }

      env {
        name  = "PORT"
        value = "3100"
      }

      env {
        name  = "SERVE_UI"
        value = "true"
      }

      env {
        name  = "PAPERCLIP_HOME"
        value = "/paperclip"
      }

      env {
        name  = "PAPERCLIP_INSTANCE_ID"
        value = "default"
      }

      env {
        name  = "PAPERCLIP_CONFIG"
        value = "/paperclip/instances/default/config.json"
      }

      env {
        name  = "PAPERCLIP_DEPLOYMENT_MODE"
        value = "authenticated"
      }

      env {
        name  = "PAPERCLIP_DEPLOYMENT_EXPOSURE"
        value = "public"
      }

      env {
        name  = "PAPERCLIP_PUBLIC_URL"
        value = local.public_url
      }

      env {
        name  = "PAPERCLIP_MIGRATION_AUTO_APPLY"
        value = "true"
      }

      env {
        name  = "HEARTBEAT_SCHEDULER_ENABLED"
        value = "true"
      }

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "BETTER_AUTH_SECRET"
        secret_name = "better-auth-secret"
      }

      dynamic "env" {
        for_each = var.anthropic_api_key_kv_name != "" ? [1] : []
        content {
          name        = "ANTHROPIC_API_KEY"
          secret_name = "anthropic-api-key"
        }
      }

      dynamic "env" {
        for_each = var.openai_api_key_kv_name != "" ? [1] : []
        content {
          name        = "OPENAI_API_KEY"
          secret_name = "openai-api-key"
        }
      }

      dynamic "env" {
        for_each = var.github_token_kv_name != "" ? [1] : []
        content {
          name        = "GITHUB_TOKEN"
          secret_name = "github-token"
        }
      }

      liveness_probe {
        transport = "HTTP"
        port      = 3100
        path      = "/api/health"

        initial_delay           = 30
        interval_seconds        = 30
        timeout                 = 5
        failure_count_threshold = 3
      }

      readiness_probe {
        transport = "HTTP"
        port      = 3100
        path      = "/api/health"

        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 3
        success_count_threshold = 1
      }
    }
  }

  secret {
    name  = "database-url"
    value = local.database_url
  }

  secret {
    name  = "better-auth-secret"
    value = local.better_auth_secret
  }

  dynamic "secret" {
    for_each = var.anthropic_api_key_kv_name != "" ? [1] : []
    content {
      name  = "anthropic-api-key"
      value = data.azurerm_key_vault_secret.anthropic_api_key[0].value
    }
  }

  dynamic "secret" {
    for_each = var.openai_api_key_kv_name != "" ? [1] : []
    content {
      name  = "openai-api-key"
      value = data.azurerm_key_vault_secret.openai_api_key[0].value
    }
  }

  dynamic "secret" {
    for_each = var.github_token_kv_name != "" ? [1] : []
    content {
      name  = "github-token"
      value = data.azurerm_key_vault_secret.github_token[0].value
    }
  }

  ingress {
    external_enabled           = true
    target_port                = 3100
    transport                  = "http"
    allow_insecure_connections = false

    dynamic "ip_security_restriction" {
      for_each = var.allowed_ingress_ips
      content {
        name             = "allow-${ip_security_restriction.key}"
        ip_address_range = ip_security_restriction.value
        action           = "Allow"
      }
    }

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }
}
