/**
 * Type declarations for react-reconciler
 *
 * These declarations provide type information for the react-reconciler package
 * which doesn't have official @types/react-reconciler that works with v0.29.x.
 */

declare module "react-reconciler" {
  import type { ReactNode } from "react";

  // The FiberRoot is the internal root created by createContainer
  export interface FiberRoot {
    current: any;
    containerInfo: any;
    pendingChildren: any;
    tag: number;
  }

  // The OpaqueHandle is a type for internal reconciler handles
  export type OpaqueHandle = any;
  export type OpaqueRoot = FiberRoot;

  // HostConfig defines how the reconciler interacts with the host environment
  export interface HostConfig<
    Type,
    Props,
    Container,
    Instance,
    TextInstance,
    SuspenseInstance,
    HydratableInstance,
    PublicInstance,
    HostContext,
    UpdatePayload,
    ChildSet,
    TimeoutHandle,
    NoTimeout,
  > {
    // Required methods
    createInstance(
      type: Type,
      props: Props,
      rootContainer: Container,
      hostContext: HostContext,
      internalHandle: OpaqueHandle,
    ): Instance;

    createTextInstance(
      text: string,
      rootContainer: Container,
      hostContext: HostContext,
      internalHandle: OpaqueHandle,
    ): TextInstance;

    appendInitialChild(parentInstance: Instance, child: Instance | TextInstance): void;

    finalizeInitialChildren(
      instance: Instance,
      type: Type,
      props: Props,
      rootContainer: Container,
      hostContext: HostContext,
    ): boolean;

    prepareUpdate(
      instance: Instance,
      type: Type,
      oldProps: Props,
      newProps: Props,
      rootContainer: Container,
      hostContext: HostContext,
    ): UpdatePayload | null;

    shouldSetTextContent(type: Type, props: Props): boolean;

    getRootHostContext(rootContainer: Container): HostContext | null;
    getChildHostContext(
      parentHostContext: HostContext,
      type: Type,
      rootContainer: Container,
    ): HostContext;
    getPublicInstance(instance: Instance): PublicInstance;
    prepareForCommit(containerInfo: Container): Record<string, any> | null;
    resetAfterCommit(containerInfo: Container): void;
    preparePortalMount(containerInfo: Container): void;
    scheduleTimeout: typeof setTimeout;
    cancelTimeout: typeof clearTimeout;
    noTimeout: NoTimeout;
    isPrimaryRenderer: boolean;
    supportsMutation: boolean;
    supportsPersistence: boolean;
    supportsHydration: boolean;
    getCurrentEventPriority?(): number;

    // Mutation methods (when supportsMutation is true)
    appendChild?(parentInstance: Instance, child: Instance | TextInstance): void;
    appendChildToContainer?(container: Container, child: Instance | TextInstance): void;
    insertBefore?(
      parentInstance: Instance,
      child: Instance | TextInstance,
      beforeChild: Instance | TextInstance,
    ): void;
    insertInContainerBefore?(
      container: Container,
      child: Instance | TextInstance,
      beforeChild: Instance | TextInstance,
    ): void;
    removeChild?(parentInstance: Instance, child: Instance | TextInstance): void;
    removeChildFromContainer?(container: Container, child: Instance | TextInstance): void;
    commitTextUpdate?(textInstance: TextInstance, oldText: string, newText: string): void;
    commitUpdate?(
      instance: Instance,
      updatePayload: UpdatePayload,
      type: Type,
      prevProps: Props,
      nextProps: Props,
      internalHandle: OpaqueHandle,
    ): void;
    hideInstance?(instance: Instance): void;
    unhideInstance?(instance: Instance, props: Props): void;
    hideTextInstance?(textInstance: TextInstance): void;
    unhideTextInstance?(textInstance: TextInstance, text: string): void;
    clearContainer?(container: Container): void;

    // Persistence methods
    cloneInstance?(
      instance: Instance,
      updatePayload: UpdatePayload | null,
      type: Type,
      oldProps: Props,
      newProps: Props,
      internalHandle: OpaqueHandle,
      keepChildren: boolean,
      recyclableInstance: Instance | null,
    ): Instance;
    createContainerChildSet?(container: Container): ChildSet;
    appendChildToContainerChildSet?(childSet: ChildSet, child: Instance | TextInstance): void;
    finalizeContainerChildren?(container: Container, newChildren: ChildSet): void;
    replaceContainerChildren?(container: Container, newChildren: ChildSet): void;
    cloneHiddenInstance?(
      instance: Instance,
      type: Type,
      props: Props,
      internalHandle: OpaqueHandle,
    ): Instance;
    cloneHiddenTextInstance?(
      instance: TextInstance,
      text: string,
      internalHandle: OpaqueHandle,
    ): TextInstance;

    // Scope and instance methods (React 18+)
    getInstanceFromNode?(node: any): Instance | null;
    beforeActiveInstanceBlur?(): void;
    afterActiveInstanceBlur?(): void;
    prepareScopeUpdate?(scopeInstance: any, instance: Instance): void;
    getInstanceFromScope?(scopeInstance: any): Instance | null;
    detachDeletedInstance?(instance: Instance): void;

    // Hydration methods
    canHydrateInstance?(instance: HydratableInstance, type: Type, props: Props): Instance | null;
    canHydrateTextInstance?(instance: HydratableInstance, text: string): TextInstance | null;
    canHydrateSuspenseInstance?(instance: HydratableInstance): SuspenseInstance | null;
    isSuspenseInstancePending?(instance: SuspenseInstance): boolean;
    isSuspenseInstanceFallback?(instance: SuspenseInstance): boolean;
    registerSuspenseInstanceRetry?(instance: SuspenseInstance, callback: () => void): void;
    getNextHydratableSibling?(instance: HydratableInstance): HydratableInstance | null;
    getFirstHydratableChild?(parentInstance: Container | Instance): HydratableInstance | null;
    hydrateInstance?(
      instance: Instance,
      type: Type,
      props: Props,
      rootContainerInstance: Container,
      hostContext: HostContext,
      internalHandle: OpaqueHandle,
    ): UpdatePayload | null;
    hydrateTextInstance?(
      textInstance: TextInstance,
      text: string,
      internalHandle: OpaqueHandle,
    ): boolean;
    hydrateSuspenseInstance?(
      suspenseInstance: SuspenseInstance,
      internalHandle: OpaqueHandle,
    ): void;
    getNextHydratableInstanceAfterSuspenseInstance?(
      suspenseInstance: SuspenseInstance,
    ): HydratableInstance | null;
    getParentSuspenseInstance?(targetInstance: Instance): SuspenseInstance | null;
    commitHydratedContainer?(container: Container): void;
    commitHydratedSuspenseInstance?(suspenseInstance: SuspenseInstance): void;
    clearSuspenseBoundary?(parentInstance: Instance, suspenseInstance: SuspenseInstance): void;
    clearSuspenseBoundaryFromContainer?(
      container: Container,
      suspenseInstance: SuspenseInstance,
    ): void;
    didNotMatchHydratedContainerTextInstance?(
      parentContainer: Container,
      textInstance: TextInstance,
      text: string,
    ): void;
    didNotMatchHydratedTextInstance?(
      parentType: Type,
      parentProps: Props,
      parentInstance: Instance,
      textInstance: TextInstance,
      text: string,
    ): void;
    didNotHydrateContainerInstance?(
      parentContainer: Container,
      instance: Instance | TextInstance,
    ): void;
    didNotHydrateInstance?(
      parentType: Type,
      parentProps: Props,
      parentInstance: Instance,
      instance: Instance | TextInstance,
    ): void;
    didNotFindHydratableContainerInstance?(
      parentContainer: Container,
      type: Type,
      props: Props,
    ): void;
    didNotFindHydratableContainerTextInstance?(parentContainer: Container, text: string): void;
    didNotFindHydratableContainerSuspenseInstance?(parentContainer: Container): void;
    didNotFindHydratableInstance?(
      parentType: Type,
      parentProps: Props,
      parentInstance: Instance,
      type: Type,
      props: Props,
    ): void;
    didNotFindHydratableTextInstance?(
      parentType: Type,
      parentProps: Props,
      parentInstance: Instance,
      text: string,
    ): void;
    didNotFindHydratableSuspenseInstance?(
      parentType: Type,
      parentProps: Props,
      parentInstance: Instance,
    ): void;
    errorHydratingContainer?(parentContainer: Container): void;
  }

  // Reconciler type returned by createReconciler
  export interface Reconciler<
    Type,
    Props,
    Container,
    Instance,
    TextInstance,
    SuspenseInstance,
    HydratableInstance,
    PublicInstance,
    HostContext,
    UpdatePayload,
    ChildSet,
    TimeoutHandle,
    NoTimeout,
  > {
    createContainer(
      containerInfo: Container,
      tag: number,
      hydrationCallbacks: null | { onHydrated?: () => void; onDeleted?: () => void },
      isStrictMode: boolean,
      concurrentUpdatesByDefaultOverride: null | boolean,
      identifierPrefix: string,
      onUncaughtError: (error: Error) => void,
      onCaughtError: (error: Error) => void,
      onRecoverableError: (error: Error) => void,
      transitionCallbacks: null | Record<string, any>,
    ): FiberRoot;

    updateContainer(
      element: ReactNode,
      container: FiberRoot,
      parentComponent?: React.Component<any, any> | null,
      callback?: (() => void) | null,
    ): void;

    flushSync<T>(fn: () => T): T;
    flushPassiveEffects(): boolean;

    getPublicRootInstance(container: FiberRoot): Instance | null;
    findHostInstance(component: any): Instance | null;
    findHostInstanceWithNoPortals(fiber: any): Instance | null;

    injectIntoDevTools(options: {
      bundleType: number;
      version: string;
      rendererPackageName: string;
    }): boolean;
  }

  export const ConcurrentRoot: number;
  export const LegacyRoot: number;
  export const DefaultEventPriority: number;

  export default function createReconciler<
    Type,
    Props,
    Container,
    Instance,
    TextInstance,
    SuspenseInstance,
    HydratableInstance,
    PublicInstance,
    HostContext,
    UpdatePayload,
    ChildSet,
    TimeoutHandle,
    NoTimeout,
  >(
    hostConfig: HostConfig<
      Type,
      Props,
      Container,
      Instance,
      TextInstance,
      SuspenseInstance,
      HydratableInstance,
      PublicInstance,
      HostContext,
      UpdatePayload,
      ChildSet,
      TimeoutHandle,
      NoTimeout
    >,
  ): Reconciler<
    Type,
    Props,
    Container,
    Instance,
    TextInstance,
    SuspenseInstance,
    HydratableInstance,
    PublicInstance,
    HostContext,
    UpdatePayload,
    ChildSet,
    TimeoutHandle,
    NoTimeout
  >;
}
