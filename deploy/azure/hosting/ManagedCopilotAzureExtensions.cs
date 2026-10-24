using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Azure;
using Aspire.Hosting.Azure.AppContainers;
using Azure.Provisioning;
using Azure.Provisioning.AppContainers;
using Azure.Provisioning.Expressions;
using Azure.Provisioning.Network;
using Azure.Provisioning.Storage;
using FileShare = Azure.Provisioning.Storage.FileShare;

namespace ManagedCopilot.Hosting.Azure;

/// <summary>
/// Azure Container Apps settings for Managed Copilot that the TypeScript AppHost API does not expose. Each method
/// changes publish output only; <c>aspire run</c> is unaffected.
/// </summary>
public static class ManagedCopilotAzureExtensions
{
    /// <summary>Name of the environment storage that holds the platform's durable state (an NFS share).</summary>
    public const string DataStorageName = "mcdata";

    private const string DataVolumeName = "data";

    /// <summary>
    /// Places the Container Apps environment in a new virtual network and gives it an Azure Files NFS share for durable
    /// state. NFS keeps POSIX locks, permissions, and symbolic links, which the gateway's SQLite ledger and the stock
    /// runtime's session store need; Azure Files SMB does not. The share is reachable only from the environment's subnet.
    /// </summary>
    /// <param name="builder">The Container Apps environment.</param>
    /// <param name="addressSpace">The virtual network's address space, a /16 such as 10.42.0.0/16.</param>
    /// <param name="shareQuotaGiB">Provisioned size of the NFS share in GiB (at least 32).</param>
    /// <returns>The environment, for chaining.</returns>
    [AspireExport]
    public static IResourceBuilder<AzureContainerAppEnvironmentResource> WithManagedCopilotNetworkAndStorage(
        this IResourceBuilder<AzureContainerAppEnvironmentResource> builder,
        string addressSpace,
        int shareQuotaGiB)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var prefixes = SubnetPrefixes(addressSpace);
        if (shareQuotaGiB < 32)
        {
            throw new ArgumentOutOfRangeException(nameof(shareQuotaGiB), "An SSD (provisioned v2) NFS share is at least 32 GiB.");
        }
        builder.WithAnnotation(new ManagedCopilotNetworkAnnotation(addressSpace, prefixes.Platform, prefixes.Sandboxes), ResourceAnnotationMutationBehavior.Replace);

        return builder.ConfigureInfrastructure(infra =>
        {
            var environment = infra.GetProvisionableResources().OfType<ContainerAppManagedEnvironment>().Single();

            var network = new VirtualNetwork("mcNetwork")
            {
                AddressSpace = new VirtualNetworkAddressSpace { AddressPrefixes = { addressSpace } },
            };
            var platform = new SubnetResource("mcPlatformSubnet")
            {
                Parent = network,
                Name = "platform",
                AddressPrefix = prefixes.Platform,
                Delegations = { new ServiceDelegation { Name = "containerapps", ServiceName = "Microsoft.App/environments" } },
                ServiceEndpoints = { new ServiceEndpointProperties { Service = "Microsoft.Storage" } },
            };
            var sandboxes = new SubnetResource("mcSandboxSubnet")
            {
                Parent = network,
                Name = "sandboxes",
                AddressPrefix = prefixes.Sandboxes,
                Delegations = { new ServiceDelegation { Name = "containerapps", ServiceName = "Microsoft.App/environments" } },
            };
            // Azure applies one change per virtual network at a time; create the subnets in order.
            sandboxes.DependsOn.Add(platform);
            environment.VnetConfiguration = new ContainerAppVnetConfiguration { InfrastructureSubnetId = platform.Id, IsInternal = false };

            var account = new StorageAccount("mcData")
            {
                Kind = StorageKind.FileStorage,
                Sku = new StorageSku { Name = StorageSkuName.PremiumV2Lrs },
                // Container Apps cannot mount NFS shares with encryption in transit; access is limited to the VNet below.
                EnableHttpsTrafficOnly = false,
                MinimumTlsVersion = StorageMinimumTlsVersion.Tls1_2,
                AllowSharedKeyAccess = false,
                AllowBlobPublicAccess = false,
                NetworkRuleSet = new StorageAccountNetworkRuleSet
                {
                    DefaultAction = StorageNetworkDefaultAction.Deny,
                    Bypass = StorageNetworkBypass.None,
                    VirtualNetworkRules = { new StorageAccountVirtualNetworkRule { VirtualNetworkResourceId = platform.Id } },
                },
            };
            var files = new FileService("mcDataFiles") { Parent = account };
            var share = new FileShare("mcDataShare")
            {
                Parent = files,
                Name = "managed-copilot",
                EnabledProtocol = FileShareEnabledProtocol.Nfs,
                RootSquash = RootSquashType.NoRootSquash,
                ShareQuota = shareQuotaGiB,
            };
            var storage = new ContainerAppManagedEnvironmentStorage("mcDataStorage")
            {
                Parent = environment,
                Name = DataStorageName,
                Properties = new ManagedEnvironmentStorageProperties
                {
                    NfsAzureFile = new ContainerAppNfsAzureFileProperties
                    {
                        Server = BicepFunction.Interpolate($"{account.Name}.file.core.windows.net"),
                        ShareName = BicepFunction.Interpolate($"/{account.Name}/{share.Name}"),
                        AccessMode = ContainerAppAccessMode.ReadWrite,
                    },
                },
            };
            storage.DependsOn.Add(share);

            infra.Add(network);
            infra.Add(platform);
            infra.Add(sandboxes);
            infra.Add(account);
            infra.Add(files);
            infra.Add(share);
            infra.Add(storage);
            infra.Add(new ProvisioningOutput("MANAGED_COPILOT_SANDBOX_SUBNET_ID", typeof(string)) { Value = sandboxes.Id });
            infra.Add(new ProvisioningOutput("MANAGED_COPILOT_DATA_STORAGE", typeof(string)) { Value = storage.Name });
        });
    }

    /// <summary>
    /// Runs the gateway as the only writer of its data directory: exactly one replica, Single revision mode, the NFS share
    /// mounted at <c>/data</c>, and probes that suit the lease supervisor (liveness over TCP so a replica waiting for the
    /// lease is not restarted; readiness over HTTP so it receives no traffic until it holds the lease).
    /// </summary>
    /// <param name="builder">The gateway container.</param>
    /// <param name="environment">The environment configured with <see cref="WithManagedCopilotNetworkAndStorage"/>.</param>
    /// <param name="targetPort">The gateway's HTTP port.</param>
    /// <param name="healthPath">The gateway's health route.</param>
    /// <returns>The gateway, for chaining.</returns>
    [AspireExport]
    public static IResourceBuilder<ContainerResource> PublishAsManagedCopilotGateway(
        this IResourceBuilder<ContainerResource> builder,
        IResourceBuilder<AzureContainerAppEnvironmentResource> environment,
        int targetPort,
        string healthPath)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(environment);
        return builder.PublishAsAzureContainerApp((infra, app) =>
        {
            ConfigureSingleWriter(app, "gateway", "/data");
            AddSupervisedProbes(app, targetPort, healthPath);
        });
    }

    /// <summary>
    /// Runs an app that keeps state on the platform's NFS share (one subdirectory per app) the way the gateway runs:
    /// one replica, Single revision mode, and the probes for the lease supervisor its image starts with. Restricts its
    /// public ingress to the given source ranges; the platform subnet (the gateway, for webhooks) is always allowed.
    /// </summary>
    /// <param name="builder">The app container.</param>
    /// <param name="environment">The environment configured with <see cref="WithManagedCopilotNetworkAndStorage"/>.</param>
    /// <param name="subPath">The app's directory on the share, for example <c>apps/assistant</c>.</param>
    /// <param name="mountPath">Where the directory appears in the container.</param>
    /// <param name="targetPort">The app's HTTP port.</param>
    /// <param name="healthPath">The app's health route (200 when it serves; the waiting replica answers 503).</param>
    /// <param name="allowedSourceCidrs">Comma-separated IPv4 CIDRs allowed to reach the app's ingress; empty allows any.</param>
    /// <returns>The app, for chaining.</returns>
    [AspireExport]
    public static IResourceBuilder<ContainerResource> PublishAsManagedCopilotApp(
        this IResourceBuilder<ContainerResource> builder,
        IResourceBuilder<AzureContainerAppEnvironmentResource> environment,
        string subPath,
        string mountPath,
        int targetPort,
        string healthPath,
        string allowedSourceCidrs)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(environment);
        var network = environment.Resource.Annotations.OfType<ManagedCopilotNetworkAnnotation>().SingleOrDefault()
            ?? throw new InvalidOperationException($"Call WithManagedCopilotNetworkAndStorage on {environment.Resource.Name} before publishing apps to it.");
        var cidrs = (allowedSourceCidrs ?? string.Empty)
            .Split([',', ' ', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToArray();
        if (cidrs.Length > 0) cidrs = [.. cidrs, network.PlatformSubnet];
        return builder.PublishAsAzureContainerApp((infra, app) =>
        {
            ConfigureSingleWriter(app, subPath, mountPath);
            AddSupervisedProbes(app, targetPort, healthPath);
            if (cidrs.Length > 0 && app.Configuration.Ingress is { } ingress)
            {
                for (var index = 0; index < cidrs.Length; index++)
                {
                    ingress.IPSecurityRestrictions.Add(new ContainerAppIPSecurityRestrictionRule
                    {
                        Name = cidrs[index] == network.PlatformSubnet ? "platform" : $"allow-{index + 1}",
                        IPAddressRange = cidrs[index],
                        Action = ContainerAppIPRuleAction.Allow,
                    });
                }
            }
        });
    }

    /// <summary>
    /// Probes for a process started by the lease supervisor: liveness over TCP so a replica waiting for the lease is not
    /// restarted, readiness over HTTP so it receives no traffic until it holds the lease and its process serves.
    /// </summary>
    private static void AddSupervisedProbes(ContainerApp app, int targetPort, string healthPath)
    {
        // The supervisor gives the old process 25 s to stop before SIGKILL; leave room for it and the handover.
        app.Template.TerminationGracePeriodSeconds = 45;
        var container = MainContainer(app);
        container.Probes.Add(new ContainerAppProbe
        {
            ProbeType = ContainerAppProbeType.Startup,
            TcpSocket = new ContainerAppTcpSocketRequestInfo { Port = targetPort },
            PeriodSeconds = 5,
            FailureThreshold = 60,
        });
        container.Probes.Add(new ContainerAppProbe
        {
            ProbeType = ContainerAppProbeType.Liveness,
            TcpSocket = new ContainerAppTcpSocketRequestInfo { Port = targetPort },
            PeriodSeconds = 15,
            FailureThreshold = 4,
        });
        container.Probes.Add(new ContainerAppProbe
        {
            ProbeType = ContainerAppProbeType.Readiness,
            HttpGet = new ContainerAppHttpRequestInfo { Path = healthPath, Port = targetPort },
            PeriodSeconds = 5,
            FailureThreshold = 3,
            TimeoutSeconds = 3,
        });
    }

    private static void ConfigureSingleWriter(ContainerApp app, string subPath, string mountPath)
    {
        app.Template.Scale.MinReplicas = 1;
        app.Template.Scale.MaxReplicas = 1;
        app.Configuration.ActiveRevisionsMode = ContainerAppActiveRevisionsMode.Single;
        app.Template.Volumes.Add(new ContainerAppVolume
        {
            Name = DataVolumeName,
            StorageType = ContainerAppStorageType.NfsAzureFile,
            StorageName = DataStorageName,
        });
        MainContainer(app).VolumeMounts.Add(new ContainerAppVolumeMount { VolumeName = DataVolumeName, MountPath = mountPath, SubPath = subPath });
    }

    private static ContainerAppContainer MainContainer(ContainerApp app) =>
        app.Template.Containers.Single().Value ?? throw new InvalidOperationException($"Container app {app.BicepIdentifier} must have exactly one container.");

    private static (string Platform, string Sandboxes) SubnetPrefixes(string addressSpace)
    {
        var parts = addressSpace.Split('/');
        var octets = parts[0].Split('.');
        if (parts.Length != 2 || parts[1] != "16" || octets.Length != 4 || octets.Any(octet => !byte.TryParse(octet, out _)) || octets[2] != "0" || octets[3] != "0")
        {
            throw new ArgumentException($"The address space must be an IPv4 /16 such as 10.42.0.0/16 (got \"{addressSpace}\").", nameof(addressSpace));
        }
        var prefix = $"{octets[0]}.{octets[1]}";
        return ($"{prefix}.0.0/23", $"{prefix}.2.0/23");
    }
}

/// <summary>The platform's virtual network layout, recorded on the Container Apps environment.</summary>
/// <param name="AddressSpace">The virtual network's /16.</param>
/// <param name="PlatformSubnet">The environment's infrastructure subnet (the gateway and apps).</param>
/// <param name="SandboxSubnet">The subnet isolated sandboxes connect through.</param>
public sealed record ManagedCopilotNetworkAnnotation(string AddressSpace, string PlatformSubnet, string SandboxSubnet) : IResourceAnnotation;
