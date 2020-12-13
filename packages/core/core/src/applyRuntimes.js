// @flow strict-local

import type {Dependency, NamedBundle as INamedBundle} from '@parcel/types';
import type {
  AssetGroup,
  Bundle as InternalBundle,
  NodeId,
  ParcelOptions,
} from './types';
import type AssetGraphBuilder from './AssetGraphBuilder';
import type ParcelConfig from './ParcelConfig';
import type PluginOptions from './public/PluginOptions';

import path from 'path';
import assert from 'assert';
import invariant from 'assert';
import nullthrows from 'nullthrows';
import AssetGraph, {nodeFromAssetGroup} from './AssetGraph';
import BundleGraph from './public/BundleGraph';
import InternalBundleGraph from './BundleGraph';
import {NamedBundle} from './public/Bundle';
import {setDifference, md5FromString} from '@parcel/utils';
import {PluginLogger} from '@parcel/logger';
import ThrowableDiagnostic, {errorToDiagnostic} from '@parcel/diagnostic';
import {dependencyToInternalDependency} from './public/Dependency';
import SourceMap from '@parcel/source-map';

type RuntimeConnection = {|
  bundle: InternalBundle,
  assetGroup: AssetGroup,
  dependency: ?Dependency,
  isEntry: ?boolean,
|};

export default async function applyRuntimes({
  bundleGraph,
  config,
  options,
  pluginOptions,
  runtimesBuilder,
}: {|
  bundleGraph: InternalBundleGraph,
  config: ParcelConfig,
  options: ParcelOptions,
  pluginOptions: PluginOptions,
  runtimesBuilder: AssetGraphBuilder,
|}): Promise<void> {
  let connections: Array<RuntimeConnection> = [];

  for (let bundle of bundleGraph.getBundles()) {
    let runtimes = await config.getRuntimes(bundle.env.context);
    for (let runtime of runtimes) {
      try {
        let applied = await runtime.plugin.apply({
          bundle: NamedBundle.get(bundle, bundleGraph, options),
          bundleGraph: new BundleGraph<INamedBundle>(
            bundleGraph,
            NamedBundle.get,
            options,
          ),
          options: pluginOptions,
          logger: new PluginLogger({origin: runtime.name}),
        });

        if (applied) {
          let runtimeAssets = Array.isArray(applied) ? applied : [applied];
          for (let {code, dependency, filePath, isEntry} of runtimeAssets) {
            let sourceName = path.join(
              path.dirname(filePath),
              `runtime-${md5FromString(code)}.${bundle.type}`,
            );

            let sourcemap = SourceMap.generateEmptyMap({
              projectRoot: pluginOptions.projectRoot,
              sourceName,
              sourceContent: code,
            });

            // Don't duplicate the sourcecontent, it's already contained in the asset
            // sourcemap.setSourceContent(sourceName, code);

            let sourcesContent = {
              [sourceName]: code,
            };

            let assetGroup = {
              code,
              // This sets the real source for the sourcemap
              sourcesContent,
              mapBuffer: await sourcemap.toBuffer(),
              filePath,
              env: bundle.env,
              // Runtime assets should be considered source, as they should be
              // e.g. compiled to run in the target environment
              isSource: true,
              query: {},
            };

            connections.push({
              bundle,
              assetGroup,
              dependency: dependency,
              isEntry,
            });
          }
        }
      } catch (e) {
        throw new ThrowableDiagnostic({
          diagnostic: errorToDiagnostic(e, runtime.name),
        });
      }
    }
  }

  let runtimesAssetGraph = await reconcileNewRuntimes(
    runtimesBuilder,
    connections,
  );

  let runtimesGraph = InternalBundleGraph.fromAssetGraph(
    runtimesAssetGraph,
    bundleGraph._publicIdByAssetId,
    bundleGraph._assetPublicIds,
  );

  // Merge the runtimes graph into the main bundle graph.
  bundleGraph.merge(runtimesGraph);
  for (let [assetId, publicId] of runtimesGraph._publicIdByAssetId) {
    bundleGraph._publicIdByAssetId.set(assetId, publicId);
    bundleGraph._assetPublicIds.add(publicId);
  }

  for (let {bundle, assetGroup, dependency, isEntry} of connections) {
    let assetGroupNode = nodeFromAssetGroup(assetGroup);
    let assetGroupAssets = runtimesAssetGraph.getNodesConnectedFrom(
      assetGroupNode,
    );
    invariant(assetGroupAssets.length === 1);
    let runtimeNode = assetGroupAssets[0];
    invariant(runtimeNode.type === 'asset');

    let resolution =
      dependency &&
      bundleGraph.getDependencyResolution(
        dependencyToInternalDependency(dependency),
        bundle,
      );
    let duplicatedAssetIds: Set<NodeId> = new Set();
    runtimesGraph._graph.traverse((node, _, actions) => {
      if (node.type !== 'dependency') {
        return;
      }

      let assets = runtimesGraph._graph
        .getNodesConnectedFrom(node)
        .map(assetNode => {
          invariant(assetNode.type === 'asset');
          return assetNode.value;
        });

      for (let asset of assets) {
        if (
          bundleGraph.isAssetReachableFromBundle(asset, bundle) ||
          resolution?.id === asset.id
        ) {
          duplicatedAssetIds.add(asset.id);
          actions.skipChildren();
        }
      }
    }, runtimeNode);

    runtimesGraph._graph.traverse((node, _, actions) => {
      if (node.type === 'asset' || node.type === 'dependency') {
        if (duplicatedAssetIds.has(node.id)) {
          actions.skipChildren();
          return;
        }

        bundleGraph._graph.addEdge(bundle.id, node.id, 'contains');
      }
    }, runtimeNode);

    if (isEntry) {
      bundleGraph._graph.addEdge(
        nullthrows(bundleGraph._graph.getNode(bundle.id)).id,
        runtimeNode.id,
      );
      bundle.entryAssetIds.unshift(runtimeNode.id);
    }

    if (dependency == null) {
      // Verify this asset won't become an island
      assert(
        bundleGraph._graph.getNodesConnectedTo(runtimeNode).length > 0,
        'Runtime must have an inbound dependency or be an entry',
      );
    } else {
      bundleGraph._graph.addEdge(dependency.id, runtimeNode.id);
    }
  }
}

async function reconcileNewRuntimes(
  runtimesBuilder: AssetGraphBuilder,
  connections: Array<RuntimeConnection>,
): Promise<AssetGraph> {
  let {assetGraph} = runtimesBuilder;

  let assetRequestNodesById = new Map(
    connections
      .map(t => t.assetGroup)
      .map(request => {
        let node = nodeFromAssetGroup(request);
        return [node.id, node];
      }),
  );
  let newRequestIds = new Set(assetRequestNodesById.keys());
  let oldRequestIds = new Set(
    assetGraph.getEntryAssetGroupNodes().map(node => node.id),
  );

  let toAdd = setDifference(newRequestIds, oldRequestIds);
  let toRemove = setDifference(oldRequestIds, newRequestIds);

  assetGraph.replaceNodesConnectedTo(
    nullthrows(assetGraph.getRootNode()),
    [...toAdd].map(requestId =>
      nullthrows(assetRequestNodesById.get(requestId)),
    ),
    node => toRemove.has(node.id),
  );

  // rebuild the graph
  return (await runtimesBuilder.build()).assetGraph;
}
