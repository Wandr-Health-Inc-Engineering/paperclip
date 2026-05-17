output "container_app_name" {
  value       = azurerm_container_app.app.name
  description = "Azure Container App name"
}

output "container_app_fqdn" {
  value       = azurerm_container_app.app.latest_revision_fqdn
  description = "Default HTTPS hostname for the deployment"
}

output "app_url" {
  value       = local.public_url
  description = "Configured public URL (custom domain or Container App FQDN)"
}

output "postgres_server_name" {
  value       = azurerm_postgresql_flexible_server.db.name
  description = "PostgreSQL flexible server name"
}

output "postgres_fqdn" {
  value       = azurerm_postgresql_flexible_server.db.fqdn
  description = "PostgreSQL server hostname"
}

output "postgres_database_name" {
  value       = azurerm_postgresql_flexible_server_database.db.name
  description = "PostgreSQL database name"
}

output "postgres_admin_username" {
  value       = var.postgres_admin_username
  description = "PostgreSQL administrator username"
}

output "postgres_admin_password" {
  value       = random_password.postgres_admin.result
  description = "PostgreSQL administrator password"
  sensitive   = true
}

output "database_url" {
  value       = local.database_url
  description = "DATABASE_URL connection string for the Paperclip application"
  sensitive   = true
}

output "storage_account_name" {
  value       = azurerm_storage_account.scout.name
  description = "Storage account backing Scout instance data on Azure Files"
}

output "storage_share_name" {
  value       = azurerm_storage_share.scout_data.name
  description = "Azure file share name for Scout instance data (mounted at /paperclip)"
}
