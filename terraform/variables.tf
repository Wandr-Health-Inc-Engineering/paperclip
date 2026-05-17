variable "azure_subscription_id" {
  description = "Azure subscription ID for deployment"
  type        = string
  default     = "63d73304-92db-4dc0-ba30-71a57ad058be"
}

variable "main_resouce_group_name" {
  type        = string
  description = "Resource group that hosts shared assets (ACR, Key Vault)"
  default     = "travelwithwandr.com"
}

variable "dev_backend" {
  type        = string
  description = "Dev backend resource group name"
  default     = "dev-wandrbackend"
}

variable "prod_backend" {
  type        = string
  description = "Prod backend resource group name"
  default     = "prod-wandrbackend"
}

variable "environment" {
  description = "Deployment environment (dev or prod)"
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "dev_tag" {
  description = "Container image tag for dev"
  type        = string
  default     = "dev"
}

variable "prod_tag" {
  description = "Container image tag for prod"
  type        = string
  default     = "latest"
}

variable "dev_container_env" {
  description = "Dev Container Apps environment name (create in Azure before apply)"
  type        = string
  default     = "dev-scout-env"
}

variable "prod_container_env" {
  description = "Prod Container Apps environment name (create in Azure before apply)"
  type        = string
  default     = "prod-scout-env"
}

variable "container_image_name" {
  description = "Image repository name in ACR (wandrapps)"
  type        = string
  default     = "scout"
}

variable "postgres_server_name" {
  description = "PostgreSQL flexible server name (auto-generated when empty)"
  type        = string
  default     = ""
}

variable "postgres_admin_username" {
  description = "PostgreSQL administrator login"
  type        = string
  default     = "scoutadmin"
}

variable "postgres_database_name" {
  description = "Application database name"
  type        = string
  default     = "scout"
}

variable "postgres_version" {
  description = "PostgreSQL major version"
  type        = string
  default     = "17"
}

variable "postgres_sku_name" {
  description = "PostgreSQL flexible server SKU"
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  description = "PostgreSQL storage size in MB"
  type        = number
  default     = 32768
}

variable "postgres_location" {
  description = "Azure region for PostgreSQL (flexible server location)"
  type        = string
  default     = "westus2"
}

variable "admin_firewall_ip" {
  description = "Optional admin IP allowed to connect to PostgreSQL for debugging"
  type        = string
  default     = "68.225.218.10"
}

variable "scout_public_url" {
  description = "Public URL used by Better Auth and the UI (set after first deploy if using a custom domain)"
  type        = string
  default     = ""
}

variable "allowed_ingress_ips" {
  description = "CIDRs allowed to reach the Container App ingress (empty = allow all)"
  type        = list(string)
  default     = []
}

variable "dev_min_replicas" {
  type    = number
  default = 1
}

variable "dev_max_replicas" {
  type    = number
  default = 1
}

variable "prod_min_replicas" {
  type    = number
  default = 1
}

variable "prod_max_replicas" {
  type    = number
  default = 2
}

variable "dev_container_cpu" {
  type    = number
  default = 1.0
}

variable "dev_container_memory" {
  type    = string
  default = "2Gi"
}

variable "prod_container_cpu" {
  type    = number
  default = 2.0
}

variable "prod_container_memory" {
  type    = string
  default = "4Gi"
}

variable "file_share_quota_gb" {
  description = "Azure Files quota for Scout instance data (mounted at /paperclip in the container)"
  type        = number
  default     = 50
}

variable "better_auth_secret_kv_name" {
  description = "Optional Key Vault secret name for BETTER_AUTH_SECRET; when empty a random secret is generated"
  type        = string
  default     = ""
}

variable "anthropic_api_key_kv_name" {
  description = "Optional Key Vault secret name for ANTHROPIC_API_KEY"
  type        = string
  default     = ""
}

variable "openai_api_key_kv_name" {
  description = "Optional Key Vault secret name for OPENAI_API_KEY"
  type        = string
  default     = ""
}

variable "github_token_kv_name" {
  description = "Optional Key Vault secret name for GITHUB_TOKEN"
  type        = string
  default     = ""
}
