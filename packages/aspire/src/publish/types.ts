/**
 * Structural view of the generated Aspire TypeScript SDK members that publish mode uses. Like `../aspire.ts`, this never
 * imports an AppHost's generated module: the AppHost passes its own builder, and these names only describe what the
 * publish code calls. `withManagedCopilot*` / `publishAsManagedCopilot*` come from the C# integration in
 * `deploy/azure/hosting` (referenced from aspire.config.json).
 */

/** Anything Aspire can inject as an environment variable or build argument: a string, parameter, endpoint, output, or expression. */
export type PublishValue = string | object;

export interface PublishOutputReference {
  value(): Promise<string | null>;
}

export interface PublishContainer extends PromiseLike<PublishContainerResource> {
  withBuildArg(name: string, value: PublishValue): PublishContainer;
  withContainerBuildOptions(callback: (context: { targetPlatform: { set(value: string): Promise<void> } }) => Promise<void>): PublishContainer;
  withHttpEndpoint(options: { targetPort?: number; env?: string; name?: string }): PublishContainer;
  withExternalHttpEndpoints(): PublishContainer;
  withEnvironment(name: string, value: PublishValue): PublishContainer;
  withEnvironmentCallback(callback: (context: PublishEnvironmentContext) => Promise<void>): PublishContainer;
  withComputeEnvironment(environment: PublishEnvironmentResource): PublishContainer;
  withAzureUserAssignedIdentity(identity: PublishAzureResource): PublishContainer;
  waitFor(resource: object): PublishContainer;
  publishAsManagedCopilotGateway(environment: PublishEnvironmentResource, targetPort: number, healthPath: string): PublishContainer;
  publishAsManagedCopilotApp(
    environment: PublishEnvironmentResource,
    subPath: string,
    mountPath: string,
    targetPort: number,
    healthPath: string,
    allowedSourceCidrs: string,
  ): PublishContainer;
}

export interface PublishContainerResource {
  getEndpoint(name: string): PromiseLike<object>;
  withEnvironment(name: string, value: PublishValue): PublishContainer;
}

export interface PublishEnvironmentContext {
  environment(): { set(name: string, value: PublishValue): PromiseLike<unknown> };
}

export interface PublishEnvironment extends PromiseLike<PublishEnvironmentResource> {
  withManagedCopilotNetworkAndStorage(addressSpace: string, shareQuotaGiB: number): PublishEnvironment;
}

export interface PublishEnvironmentResource {
  getOutput(name: string): PromiseLike<PublishOutputReference & object>;
}

/** An Azure resource with Bicep outputs (a user-assigned identity, a Bicep template). */
export interface PublishAzureResource {
  getOutput(name: string): PromiseLike<PublishOutputReference & object>;
}

export interface PublishBicep extends PromiseLike<PublishAzureResource> {
  withParameter(name: string, options: { value: PublishValue }): PublishBicep;
}

export interface PublishPipeline {
  addStep(name: string, callback: (context: PublishStepContext) => Promise<void>, options?: { dependsOn?: string[]; requiredBy?: string[] }): PromiseLike<unknown>;
}

export interface PublishReportingTask {
  updateTask(statusText: string): PromiseLike<unknown>;
  completeTask(options?: { completionMessage?: string; completionState?: string }): PromiseLike<unknown>;
}

export interface PublishStepContext {
  reportingStep(): PromiseLike<{
    createTask(statusText: string): PromiseLike<PublishReportingTask>;
    logStep(level: string, message: string): PromiseLike<unknown>;
  }>;
  summary(): PromiseLike<{ add(key: string, value: string): PromiseLike<unknown> }>;
}

export interface PublishConfiguration {
  exists(key: string): Promise<boolean>;
  getConfigValue(key: string): Promise<string>;
}

/** The generated `DistributedApplicationBuilder` members publish mode uses. */
export interface PublishBuilder {
  appHostDirectory(): Promise<string>;
  addAzureContainerAppEnvironment(name: string): PublishEnvironment;
  addDockerfile(name: string, contextPath: string, options?: { dockerfilePath?: string; stage?: string }): PublishContainer;
  addParameter(name: string, options?: { secret?: boolean; value?: string }): PromiseLike<object>;
  addParameterWithGeneratedValue(name: string, value: { minLength?: number; special?: boolean }, options?: { secret?: boolean; persist?: boolean }): PromiseLike<object>;
  addAzureUserAssignedIdentity(name: string): PromiseLike<PublishAzureResource>;
  addBicepTemplateString(name: string, bicepContent: string): PublishBicep;
  getConfiguration(): PromiseLike<PublishConfiguration>;
  pipeline(): PublishPipeline;
}
