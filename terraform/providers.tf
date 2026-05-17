terraform {
  required_version = ">=1.11.4"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">=4.26.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">=3.1.0"
    }
    time = {
      source  = "hashicorp/time"
      version = ">=0.9.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.azure_subscription_id
}
