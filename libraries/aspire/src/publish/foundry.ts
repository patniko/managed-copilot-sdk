/**
 * Access to an Azure AI Foundry account the AppHost declares (`foundry`, spec section 15), as a Bicep template
 * `aspire deploy` provisions with the platform: the gateway's managed identity gets the Cognitive Services OpenAI User
 * role on the account, which allows model calls (and reading the account and its deployments) and nothing else.
 *
 * The account already exists, often in another resource group or subscription than the deployment, so the role
 * assignment is a nested deployment targeted at the account's resource group. The deploying user needs permission to
 * assign roles there (Owner, User Access Administrator, or Role Based Access Control Administrator).
 */
export const FOUNDRY_ACCESS_BICEP = `@description('The location for the resource(s) to be deployed.')
param location string = resourceGroup().location

@description('Name of the Azure AI Foundry (AIServices) account.')
param accountName string

@description('Resource group of the account.')
param accountResourceGroup string

@description('Subscription of the account; empty for this deployment\\'s.')
param accountSubscription string = ''

@description('Principal ID of the gateway identity, which calls the account\\'s models.')
param gatewayPrincipalId string

var subscriptionId = empty(accountSubscription) ? subscription().subscriptionId : accountSubscription
// Cognitive Services OpenAI User: model calls, and reading the account and its deployments.
var openAiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
var accountId = resourceId(subscriptionId, accountResourceGroup, 'Microsoft.CognitiveServices/accounts', accountName)

// Every value is computed here, in this template: Bicep writes the nested template's strings literally, so it holds
// no expressions of its own.
resource access 'Microsoft.Resources/deployments@2022-09-01' = {
  name: take('mc-foundry-\${uniqueString(gatewayPrincipalId, accountName, location)}', 64)
  subscriptionId: subscriptionId
  resourceGroup: accountResourceGroup
  properties: {
    mode: 'Incremental'
    template: {
      '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#'
      contentVersion: '1.0.0.0'
      resources: [
        {
          type: 'Microsoft.Authorization/roleAssignments'
          apiVersion: '2022-04-01'
          scope: 'Microsoft.CognitiveServices/accounts/\${accountName}'
          name: guid(accountId, gatewayPrincipalId, openAiUser)
          properties: {
            roleDefinitionId: subscriptionResourceId(subscriptionId, 'Microsoft.Authorization/roleDefinitions', openAiUser)
            principalId: gatewayPrincipalId
            principalType: 'ServicePrincipal'
          }
        }
      ]
    }
  }
}

output subscriptionId string = subscriptionId
output deploymentSubscriptionId string = subscription().subscriptionId
`;
