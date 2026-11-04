/**
 * Structural view of the generated Aspire TypeScript SDK (`.aspire/modules/aspire.mjs`).
 *
 * The integration never imports an AppHost's generated module. The AppHost passes its own builder, and these
 * interfaces name only the members this package uses; the generated types satisfy them structurally, and
 * `addManagedCopilot` hands back the AppHost's own resource types.
 */

/** A value Aspire can inject as an environment variable: a string, parameter, endpoint reference, or expression. */
export type AspireValue = string | object;

export interface AspireHttpEndpointOptions {
  port?: number | null;
  targetPort?: number | null;
  name?: string;
  env?: string;
  isProxied?: boolean | null;
}

/** A chainable, awaitable Node app resource builder (the generated `NodeAppResourcePromise`). */
export interface AspireNodeAppBuilder extends PromiseLike<AspireNodeAppResource> {
  withPnpm(options?: { install?: boolean }): AspireNodeAppBuilder;
  withHttpEndpoint(options?: AspireHttpEndpointOptions): AspireNodeAppBuilder;
  withHttpHealthCheck(options?: { path?: string }): AspireNodeAppBuilder;
  withEnvironment(name: string, value: AspireValue): AspireNodeAppBuilder;
  withIconName(iconName: string): AspireNodeAppBuilder;
}

export interface AspireNodeAppResource {
  getEndpoint(name: string): PromiseLike<object>;
}

/** The members of the generated `DistributedApplicationBuilder` that `addManagedCopilot` uses. */
export interface AspireBuilder {
  appHostDirectory(): Promise<string>;
  executionContext(): { isPublishMode(): Promise<boolean> };
  addNodeApp(name: string, appDirectory: string, scriptPath: string): AspireNodeAppBuilder;
  addParameterWithGeneratedValue(
    name: string,
    value: { minLength?: number; special?: boolean },
    options?: { secret?: boolean; persist?: boolean },
  ): PromiseLike<object>;
  /** The AppHost's configuration (user secrets, environment); read for `Azure:SubscriptionId`. */
  getConfiguration?(): PromiseLike<{ exists(key: string): Promise<boolean>; getConfigValue(key: string): Promise<string> }>;
}

/** The AppHost's own gateway resource type (the generated `NodeAppResource`). */
export type GatewayResourceOf<B extends AspireBuilder> = Awaited<ReturnType<B["addNodeApp"]>>;

/** The AppHost's own endpoint reference type (the generated `EndpointReference`). */
export type EndpointOf<B extends AspireBuilder> = Awaited<ReturnType<GatewayResourceOf<B>["getEndpoint"]>>;

/** The AppHost's own parameter type (the generated `ParameterResource`), which its `withEnvironment` accepts. */
export type ParameterOf<B extends AspireBuilder> = Awaited<ReturnType<B["addParameterWithGeneratedValue"]>>;
