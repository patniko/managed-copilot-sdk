/**
 * The Azure Container Apps Sandboxes group that isolated sessions run in (one microVM per session), as a Bicep template
 * `aspire deploy` provisions with the rest of the platform. API version 2026-02-01-preview, qualified live in
 * deployments/azure/qualify (2026-07-01 rejects Entra v2 tokens on the data plane).
 *
 * - A VNet connection on the platform network's `sandboxes` subnet (sandboxes reach the egress proxy through it).
 * - For the gateway's identity: "Container Apps SandboxGroup Data Owner" on the group, and AcrPull on the registry. The
 *   data plane imports private images only with registry credentials, which the gateway mints with that role.
 */
export const SANDBOX_GROUP_BICEP = `@description('The location for the resource(s) to be deployed.')
param location string = resourceGroup().location

@description('Subnet (delegated to Microsoft.App/environments) the sandboxes connect to the platform network through.')
param subnetId string

@description('Name of the container registry that holds the sandbox images.')
param registryName string

@description('Principal ID of the gateway identity, which manages sandboxes in this group.')
param gatewayPrincipalId string

param tags object = {}

var suffix = uniqueString(resourceGroup().id)
var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var sandboxGroupDataOwner = 'c24cf47c-5077-412d-a19c-45202126392c'

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: registryName
}

resource sandboxGroup 'Microsoft.App/sandboxGroups@2026-02-01-preview' = {
  name: take('mc-sandboxes-\${suffix}', 32)
  location: location
  tags: tags
  properties: {}
}

resource vnetConnection 'Microsoft.App/sandboxGroups/vnetConnections@2026-02-01-preview' = {
  parent: sandboxGroup
  name: 'platform'
  location: location // required by 2026-02-01-preview
  properties: {
    subnetId: subnetId
  }
}

resource gatewayRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxGroup.id, gatewayPrincipalId, sandboxGroupDataOwner)
  scope: sandboxGroup
  properties: {
    principalId: gatewayPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sandboxGroupDataOwner)
  }
}

resource gatewayPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, gatewayPrincipalId, acrPull)
  scope: registry
  properties: {
    principalId: gatewayPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull)
  }
}

output name string = sandboxGroup.name
output region string = sandboxGroup.location
output vnetConnection string = vnetConnection.name
output subscriptionId string = subscription().subscriptionId
output resourceGroupName string = resourceGroup().name
`;
