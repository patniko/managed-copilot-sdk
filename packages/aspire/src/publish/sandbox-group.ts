/**
 * The Azure Container Apps Sandboxes group that isolated sessions run in (one microVM per session), as a Bicep template
 * `aspire deploy` provisions with the rest of the platform. API version 2026-02-01-preview is the documented shape with a
 * group identity and VNet connections (both 2026-02-01-preview and 2026-07-01 are registered for Microsoft.App).
 *
 * - A pull identity with AcrPull on the environment's registry, used only by the group to import sandbox images.
 * - A VNet connection on the platform network's `sandboxes` subnet.
 * - "Container Apps SandboxGroup Data Owner" on the group for the gateway's identity, and nothing broader.
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

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: take('mc-sandbox-pull-\${suffix}', 128)
  location: location
  tags: tags
}

resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, acrPull)
  scope: registry
  properties: {
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull)
  }
}

resource sandboxGroup 'Microsoft.App/sandboxGroups@2026-02-01-preview' = {
  name: take('mc-sandboxes-\${suffix}', 32)
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '\${pullIdentity.id}': {}
    }
  }
  properties: {}
  dependsOn: [
    pullRole
  ]
}

resource vnetConnection 'Microsoft.App/sandboxGroups/vnetConnections@2026-02-01-preview' = {
  parent: sandboxGroup
  name: 'platform'
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

output name string = sandboxGroup.name
output region string = sandboxGroup.location
output vnetConnection string = vnetConnection.name
output pullIdentityId string = pullIdentity.id
output subscriptionId string = subscription().subscriptionId
output resourceGroupName string = resourceGroup().name
`;
