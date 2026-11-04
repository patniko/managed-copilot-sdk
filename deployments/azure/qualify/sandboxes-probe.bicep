// Qualification infrastructure for Azure Container Apps Sandboxes (Phase A of the Azure plan): the same sandbox group
// shape `aspire deploy` creates (libraries/aspire/src/publish/sandbox-group.ts), the deployer's data-plane role so the
// qualification script can drive it with Azure CLI credentials, and an internal Container Apps environment hosting a
// logging forward proxy, to learn how sandbox egress reaches a private address in the VNet.
//
//   az group create -n mc-azure-probe -l westus2
//   az deployment group create -g mc-azure-probe -f deployments/azure/qualify/sandboxes-probe.bicep \
//     -p deployerPrincipalId=$(az ad signed-in-user show --query id -o tsv)
//   # after pushing the proxy image: add -p proxyImage=<registry>/probe-proxy:<tag>
//   az group delete -n mc-azure-probe --yes   # teardown
@description('The location for the resources.')
param location string = resourceGroup().location

@description('Object ID of the deployer, who drives the sandbox data plane from the qualification script.')
param deployerPrincipalId string

@description('Logging proxy image in this registry (empty: create everything else first).')
param proxyImage string = ''

var suffix = uniqueString(resourceGroup().id)
var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var sandboxGroupDataOwner = 'c24cf47c-5077-412d-a19c-45202126392c'

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'mc-probe-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: [ '10.42.0.0/16' ] }
    subnets: [
      {
        name: 'sandboxes'
        properties: {
          addressPrefix: '10.42.2.0/23'
          delegations: [ { name: 'containerapps', properties: { serviceName: 'Microsoft.App/environments' } } ]
        }
      }
      {
        name: 'egress'
        properties: {
          addressPrefix: '10.42.4.0/24'
          delegations: [ { name: 'containerapps', properties: { serviceName: 'Microsoft.App/environments' } } ]
        }
      }
    ]
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: take('mcprobe${suffix}', 50)
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'mc-probe-pull'
  location: location
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
  name: take('mc-probe-${suffix}', 32)
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentity.id}': {} }
  }
  properties: {}
  dependsOn: [ pullRole ]
}

resource vnetConnection 'Microsoft.App/sandboxGroups/vnetConnections@2026-02-01-preview' = {
  parent: sandboxGroup
  name: 'platform'
  location: location // required by 2026-02-01-preview
  properties: { subnetId: network.properties.subnets[0].id }
}

resource deployerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxGroup.id, deployerPrincipalId, sandboxGroupDataOwner)
  scope: sandboxGroup
  properties: {
    principalId: deployerPrincipalId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sandboxGroupDataOwner)
  }
}

// An internal (VNet-only) environment: an app with external ingress is published on its internal load balancer.
resource egressEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'mc-probe-egress'
  location: location
  properties: {
    vnetConfiguration: { internal: true, infrastructureSubnetId: network.properties.subnets[1].id }
    workloadProfiles: [ { name: 'Consumption', workloadProfileType: 'Consumption' } ]
  }
}

resource proxy 'Microsoft.App/containerApps@2025-01-01' = if (!empty(proxyImage)) {
  name: 'probe-proxy'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentity.id}': {} }
  }
  properties: {
    environmentId: egressEnvironment.id
    configuration: {
      ingress: { external: true, transport: 'tcp', targetPort: 3128, exposedPort: 3128 }
      registries: [ { server: registry.properties.loginServer, identity: pullIdentity.id } ]
    }
    template: {
      containers: [ { name: 'proxy', image: proxyImage, resources: { cpu: json('0.25'), memory: '0.5Gi' } } ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
  dependsOn: [ pullRole ]
}

output registryName string = registry.name
output loginServer string = registry.properties.loginServer
output pullIdentityId string = pullIdentity.id
output sandboxGroup string = sandboxGroup.name
output vnetConnection string = vnetConnection.name
output egressStaticIp string = egressEnvironment.properties.staticIp
