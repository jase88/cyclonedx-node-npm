/*!
This file is part of CycloneDX generator for NPM projects.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

SPDX-License-Identifier: Apache-2.0
Copyright (c) OWASP Foundation. All Rights Reserved.
*/

import { existsSync } from 'node:fs'
import * as path from 'node:path'

import { type Builders, Enums, type Factories, Models, Utils } from '@cyclonedx/cyclonedx-library'
import * as normalizePackageData from 'normalize-package-data'
import { type PackageURL } from 'packageurl-js'

import { type Logger } from './logger'
import { makeNpmRunner, type runFunc } from './npmRunner'
import { PropertyNames, PropertyValueBool } from './properties'
import { versionCompare } from './versionCompare'

type OmittableDependencyTypes = 'dev' | 'optional' | 'peer'

interface BomBuilderOptions {
  ignoreNpmErrors?: BomBuilder['ignoreNpmErrors']
  metaComponentType?: BomBuilder['metaComponentType']
  packageLockOnly?: BomBuilder['packageLockOnly']
  omitDependencyTypes?: Iterable<OmittableDependencyTypes>
  reproducible?: BomBuilder['reproducible']
  flattenComponents?: BomBuilder['flattenComponents']
  shortPURLs?: BomBuilder['shortPURLs']
}

type cPath = string
type AllComponents = Map<cPath, Models.Component>

export class BomBuilder {
  toolBuilder: Builders.FromNodePackageJson.ToolBuilder
  componentBuilder: Builders.FromNodePackageJson.ComponentBuilder
  treeBuilder: TreeBuilder
  purlFactory: Factories.FromNodePackageJson.PackageUrlFactory

  ignoreNpmErrors: boolean

  metaComponentType: Enums.ComponentType
  packageLockOnly: boolean
  omitDependencyTypes: Set<OmittableDependencyTypes>
  reproducible: boolean
  flattenComponents: boolean
  shortPURLs: boolean

  logger: Logger

  constructor (
    toolBuilder: BomBuilder['toolBuilder'],
    componentBuilder: BomBuilder['componentBuilder'],
    treeBuilder: BomBuilder['treeBuilder'],
    purlFactory: BomBuilder['purlFactory'],
    options: BomBuilderOptions,
    logger_: BomBuilder['logger']
  ) {
    this.toolBuilder = toolBuilder
    this.componentBuilder = componentBuilder
    this.treeBuilder = treeBuilder
    this.purlFactory = purlFactory

    this.ignoreNpmErrors = options.ignoreNpmErrors ?? false
    this.metaComponentType = options.metaComponentType ?? Enums.ComponentType.Library
    this.packageLockOnly = options.packageLockOnly ?? false
    this.omitDependencyTypes = new Set(options.omitDependencyTypes ?? [])
    this.reproducible = options.reproducible ?? false
    this.flattenComponents = options.flattenComponents ?? false
    this.shortPURLs = options.shortPURLs ?? false

    this.logger = logger_
  }

  buildFromProjectDir (projectDir: string, process: NodeJS.Process): Models.Bom {
    return this.buildFromNpmLs(
      ...this.fetchNpmLs(projectDir, process)
    )
  }

  private versionTuple (value: string): number[] {
    return value.split('.').map(v => Number(v))
  }

  private getNpmVersion (npmRunner: runFunc, process_: NodeJS.Process): string {
    let version: string
    this.logger.info('detect NPM version ...')
    try {
      version = npmRunner(['--version'], {
        env: process_.env,
        encoding: 'buffer',
        maxBuffer: Number.MAX_SAFE_INTEGER // DIRTY but effective
      }).toString().trim()
    } catch (runError: any) {
      const { stdout, message, stderr } = runError

      this.logger.debug('npm-ls: STDOUT')
      this.logger.debug('%s', stdout)

      this.logger.warn('npm-ls: MESSAGE')
      this.logger.warn('%s', message)

      this.logger.error('npm-ls: STDERR')
      this.logger.error('%s', stderr)

      throw runError
    }
    this.logger.debug('detected NPM version %j', version)
    return version
  }

  private fetchNpmLs (projectDir: string, process_: NodeJS.Process): [any, string | undefined] {
    const npmRunner = makeNpmRunner(process_, this.logger)

    const npmVersionR = this.getNpmVersion(npmRunner, process_)
    const npmVersionT = this.versionTuple(npmVersionR)

    const args: string[] = [
      'ls',
      // format as parsable json
      '--json',
      // get all the needed content
      '--long',
      // depth = infinity
      npmVersionT[0] >= 7
        ? '--all'
        : '--depth=255'
    ]

    if (this.packageLockOnly) {
      if (npmVersionT[0] >= 7) {
        args.push('--package-lock-only')
      } else {
        this.logger.warn('your NPM does not support "--package-lock-only", internally skipped this option')
      }
    }

    if (versionCompare(npmVersionT, [8, 7]) >= 0) {
      // since NPM v8.7 -- https://github.com/npm/cli/pull/4744
      for (const odt of this.omitDependencyTypes) {
        args.push(`--omit=${odt}`)
      }
    } else {
      // see https://github.com/npm/cli/pull/4744
      for (const odt of this.omitDependencyTypes) {
        switch (odt) {
          case 'dev':
            this.logger.warn('your NPM does not support "--omit=%s", internally using "--production" to mitigate', odt)
            args.push('--production')
            break
          case 'peer':
          case 'optional':
            this.logger.warn('your NPM does not support "--omit=%s", internally skipped this option', odt)
            break
        }
      }
    }

    this.logger.info('gather dependency tree ...')
    this.logger.debug('npm-ls: run npm with %j in %j', args, projectDir)
    let npmLsReturns: Buffer
    try {
      npmLsReturns = npmRunner(args, {
        cwd: projectDir,
        env: process_.env,
        encoding: 'buffer',
        maxBuffer: Number.MAX_SAFE_INTEGER // DIRTY but effective
      })
    } catch (runError: any) {
      const { message, stderr } = runError

      this.logger.warn('npm-ls: MESSAGE')
      this.logger.warn('%s', message)

      this.logger.error('npm-ls: STDERR')
      this.logger.error('%s', stderr)

      if (!this.ignoreNpmErrors) {
        throw new Error(`npm-ls exited with errors: ${
          runError.status as string ?? 'noStatus'} ${
          runError.signal as string ?? 'noSignal'}`)
      }
      this.logger.debug('npm-ls exited with errors that are to be ignored.')
      npmLsReturns = runError.stdout ?? Buffer.alloc(0)
    }

    try {
      return [
        JSON.parse(npmLsReturns.toString()),
        npmVersionR
      ]
    } catch (jsonParseError) {
      /* @ts-expect-error TS2554 */
      throw new Error('failed to parse npm-ls response', { cause: jsonParseError })
    }
  }

  buildFromNpmLs (data: any, npmVersion?: string): Models.Bom {
    this.logger.info('build BOM ...')

    // region all components & dependencies

    /* eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing --
     * as we need to enforce a proper root component to enable all features of SBOM */
    const rootComponent: Models.Component = this.makeComponent(data, this.metaComponentType) ||
      new DummyComponent(this.metaComponentType, 'RootComponent')
    const allComponents: AllComponents = new Map([[data.path, rootComponent]])
    this.gatherDependencies(allComponents, data, rootComponent.dependencies)
    this.finalizePathProperties(data.path, allComponents.values())

    // endregion all components & dependencies

    const bom = new Models.Bom()

    // region metadata

    bom.metadata.component = rootComponent

    bom.metadata.tools.add(new Models.Tool({
      name: 'npm',
      version: npmVersion // use the self-proclaimed `version`
      // omit `vendor` and `externalReferences`, because we cannot be sure about the used tool's actual origin
      // omit `hashes`, because unfortunately there is no agreed process of generating them
    }))
    for (const tool of this.makeTools()) {
      bom.metadata.tools.add(tool)
    }

    if (!this.reproducible) {
      bom.serialNumber = Utils.BomUtility.randomSerialNumber()
      bom.metadata.timestamp = new Date()
    }

    // endregion metadata

    // region components

    bom.components = this.nestComponents(
      // remove rootComponent - so the elements that are nested below it are just returned.
      new Map(Array.from(allComponents.entries()).filter(([, c]) => c !== rootComponent)),
      this.treeBuilder.fromPaths(
        new Set(allComponents.keys()),
        // do not depend on `path.sep` -- this would be runtime-dependent, not input-dependent
        data.path[0] === '/' ? '/' : '\\'
      )
    )
    bom.components.forEach(c => { this.adjustNestedBomRefs(c, '') })
    rootComponent.components.clear()

    if (this.flattenComponents) {
      for (const component of allComponents.values()) {
        component.components.clear()
        if (component !== rootComponent) {
          bom.components.add(component)
        }
      }
    }

    // endregion components

    return bom
  }

  private adjustNestedBomRefs (component: Models.Component, pref: string): void {
    if (component.bomRef.value === undefined) {
      return
    }
    component.bomRef.value = pref + component.bomRef.value
    const fill = component.bomRef.value + '|'
    component.components.forEach(c => { this.adjustNestedBomRefs(c, fill) })
  }

  private nestComponents (allComponents: AllComponents, tree: PTree): Models.ComponentRepository {
    const children = new Models.ComponentRepository()
    for (const [p, pTree] of tree) {
      const component = allComponents.get(p)
      const components = this.nestComponents(allComponents, pTree)
      if (component === undefined) {
        components.forEach(c => children.add(c))
      } else {
        component.components = components
        children.add(component)
      }
    }
    return children
  }

  private gatherDependencies (allComponents: AllComponents, data: any, directDepRefs: Set<Models.BomRef>): void {
    /* One and the same component may appear multiple times in the tree,
     * but only one occurrence has all the direct dependencies.
     * So we work only on the one `data` that actually has dependencies.
     */
    /* One and the same component may appear multiple times in the tree,
     * but only the most top-level has a complete set with all `dependencies` *and* `resolved`.
     * This detail might cause implementation changes: run over the top level first, then go into nested dependencies.
     */
    for (const [depName, depData] of Object.entries(data.dependencies ?? {}) as any) {
      if (depData === null || typeof depData !== 'object') {
        // cannot build
        continue // for-loop
      }
      if (typeof depData.path !== 'string') {
        // might be an optional dependency that was not installed
        // skip, as it was not installed anyway
        continue // for-loop
      }

      let dep = allComponents.get(depData.path)
      if (dep === undefined) {
        const _dep = this.makeComponent(depData)
        if (_dep === false) {
          // shall be skipped
          continue // for-loop
        }
        dep = _dep ??
          new DummyComponent(Enums.ComponentType.Library, `InterferedDependency.${depName as string}`)
        if (dep instanceof DummyComponent) {
          this.logger.warn('InterferedDependency $j', dep.name)
        }

        allComponents.set(depData.path, dep)
      }
      directDepRefs.add(dep.bomRef)

      this.gatherDependencies(allComponents, depData, dep.dependencies)
    }
  }

  /**
   * Some combinations/versions of `npm-install`/`npm-ls` are insufficient,
   * they fail to load package details or miss details.
   * So here is a poly-fill that loads ALL the package's data.
   */
  private enhancedPackageData <T>(data: T & { path: string }): T {
    if (!path.isAbsolute(data.path)) {
      return data
    }
    const packageJsonPath = path.join(data.path, 'package.json')
    try {
      return Object.assign(
        /* eslint-disable-next-line @typescript-eslint/no-var-requires */
        require(packageJsonPath),
        data
      )
    } catch {
      return data
    }
  }

  /**
   * See {@link https://docs.npmjs.com/cli/v9/configuring-npm/package-lock-json#packages package lock docs} for "integrity"
   * > integrity: A sha512 or sha1 [Standard Subresource Integrity](https://w3c.github.io/webappsec/specs/subresourceintegrity/)
   * > string for the artifact that was unpacked in this location.
   */
  private readonly integrityRE: ReadonlyMap<Enums.HashAlgorithm, RegExp> = new Map([
    // !!! this list is pre-sorted, starting with most-common usage.

    /* base64 alphabet: `A-Za-z0-9+/` and `=` for padding
     * SHA-512 => base64 over 512 bit => 86 chars + 2 chars padding.
     * examples:
     * - sha512-zvj65TkFeIt3i6aj5bIvJDzjjQQGs4o/sNoezg1F1kYap9Nu2jcUdpwzRSJTHMMzG0H7bZkn4rNQpImhuxWX2A==
     * - sha512-DXUS22Y57/LAFSg3x7Vi6RNAuLpTXwxB9S2nIA7msBb/Zt8p7XqMwdpdc1IU7CkOQUPgAqR5fWvxuKCbneKGmA==
     * - sha512-5BejraMXMC+2UjefDvrH0Fo/eLwZRV6859SXRg+FgbhA0R0l6lDqDGAQYhKbXhPN2ofk2kY5sgGyLNL907UXpA==
     */
    [Enums.HashAlgorithm['SHA-512'], /^sha512-([a-z0-9+/]{86}==)$/i],

    /* base64 alphabet: `A-Za-z0-9+/` and `=` for padding
     * SHA-1 => base64 over 160 bit => 27 chars + 1 chars padding.
     * examples:
     * - sha1-aSbRsZT7xze47tUTdW3i/Np+pAg=
     * - sha1-Kq5sNclPz7QV2+lfQIuc6R7oRu0=
     * - sha1-XV8g50dxuFICXD7bZslGLuuRPQM=
     */
    [Enums.HashAlgorithm['SHA-1'], /^sha1-([a-z0-9+/]{27}=)$/i],

    /* base64 alphabet: `A-Za-z0-9+/` and `=` for padding
     * SHA-256 => base64 over 256 bit => 43 chars + 1 chars padding.
     * examples:
     * - sha256-jxzgcB+8dLn7Cjjyg7stGWMftZf6rbdvgoE85TOzmT4=
     * - sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=
     * - sha256-+8Gp+Fjqnhd5FpZL2Iw9N7kaHoRBJ2XimVB3fyZcS3U=
     */
    [Enums.HashAlgorithm['SHA-256'], /^sha256-([a-z0-9+/]{43}=)$/i],

    /* base64 alphabet: `A-Za-z0-9+/` and `=` for padding
     * SHA-384 => base64 over 384 bit => 64 chars + 0 chars padding.
     * example:
     * - sha384-aDkxLz2zQ0dwcNPAsr7NQXs1cVTUh5TQHXjPtGF+1auBmne2gy9lQt0Yu3OBMe9+
     * - sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC
     * - sha384-/b2OdaZ/KfcBpOBAOF4uI5hjA+oQI5IRr5B/y7g1eLPkF8txzmRu/QgZ3YwIjeG9
     */
    [Enums.HashAlgorithm['SHA-384'], /^sha384-([a-z0-9+/]{64})$/i]
  ])

  /**
   * Ignore pattern for `resolved`.
   * - ignore: well, just ignore it ... i guess.
   * - file: local dist cannot be shipped and therefore should be ignored.
   */
  private readonly resolvedRE_ignore = /^(?:ignore|file):/i

  private makeComponent (data: any, type?: Enums.ComponentType | undefined): Models.Component | false | undefined {
    // older npm-ls versions (v6) hide properties behind a `_`
    const isOptional = (data.optional ?? data._optional) === true
    if (isOptional && this.omitDependencyTypes.has('optional')) {
      this.logger.debug('omit optional component: %j %j', data.name, data._id)
      return false
    }

    // older npm-ls versions (v6) hide properties behind a `_`
    const isDev = (data.dev ?? data._development) === true
    if (isDev && this.omitDependencyTypes.has('dev')) {
      this.logger.debug('omit dev component: %j %j', data.name, data._id)
      return false
    }

    // attention: `data.devOptional` are not to be skipped with devs, since they are still required by optionals.
    const isDevOptional = data.devOptional === true
    if (isDevOptional && this.omitDependencyTypes.has('dev') && this.omitDependencyTypes.has('optional')) {
      this.logger.debug('omit devOptional component: %j %j', data.name, data._id)
      return false
    }

    // work with a deep copy, because `normalizePackageData()` might modify the data
    let _dataC = structuredClonePolyfill(data)
    if (!this.packageLockOnly) {
      _dataC = this.enhancedPackageData(_dataC)
    }
    normalizePackageData(_dataC /* add debug for warnings? */)
    // region fix normalizations
    if (typeof data.version === 'string') {
      // allow non-SemVer strings
      _dataC.version = data.version.trim()
    }
    // endregion fix normalizations

    const component = this.componentBuilder.makeComponent(_dataC, type)
    if (component === undefined) {
      this.logger.debug('skip broken component: %j %j', data.name, data._id)
      return undefined
    }

    if (isOptional || isDevOptional) {
      component.scope = Enums.ComponentScope.Optional
    }

    // region properties

    if (typeof data.path === 'string') {
      component.properties.add(
        new Models.Property(PropertyNames.PackageInstallPath, data.path)
      )
    }
    if (isDev || isDevOptional) {
      component.properties.add(
        new Models.Property(PropertyNames.PackageDevelopment, PropertyValueBool.True)
      )
    }
    if (data.extraneous === true) {
      component.properties.add(
        new Models.Property(PropertyNames.PackageExtraneous, PropertyValueBool.True)
      )
    }
    if (data.private === true || _dataC.private === true) {
      component.properties.add(
        new Models.Property(PropertyNames.PackagePrivate, PropertyValueBool.True)
      )
    }
    // older npm-ls versions (v6) hide properties behind a `_`
    if ((data.inBundle ?? data._inBundle) === true) {
      component.properties.add(
        new Models.Property(PropertyNames.PackageBundled, PropertyValueBool.True)
      )
    }

    // endregion properties

    // older npm-ls versions (v6) hide properties behind a `_`
    const resolved = data.resolved ?? data._resolved
    if (typeof resolved === 'string' && !this.resolvedRE_ignore.test(resolved)) {
      const hashes = new Models.HashDictionary()
      // older npm-ls versions (v6) hide properties behind a `_`
      const integrity = data.integrity ?? data._integrity
      if (typeof integrity === 'string') {
        for (const [hashAlgorithm, hashRE] of this.integrityRE) {
          const hashMatchBase64 = hashRE.exec(integrity) ?? []
          if (hashMatchBase64?.length === 2) {
            hashes.set(
              hashAlgorithm,
              Buffer.from(hashMatchBase64[1], 'base64').toString('hex')
            )
            break // there is only one hash in "integrity"
          }
        }
      }
      component.externalReferences.add(
        new Models.ExternalReference(
          resolved,
          Enums.ExternalReferenceType.Distribution,
          {
            hashes,
            comment: 'as detected from npm-ls property "resolved"' +
              (hashes.size > 0 ? ' and property "integrity"' : '')
          }
        )
      )
    }

    // even private packages may have a PURL for identification
    component.purl = this.makePurl(component)

    /* eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- since empty-string handling is needed */
    component.bomRef.value = (typeof data._id === 'string' ? data._id : undefined) ||
      /* eslint-disable-next-line @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing -- since empty-string handling is needed */
      `${component.group || '-'}/${component.name}@${component.version || '-'}`

    return component
  }

  private makePurl (component: Models.Component): PackageURL | undefined {
    const purl = this.purlFactory.makeFromComponent(component, this.reproducible)
    if (purl === undefined) {
      return undefined
    }

    if (this.shortPURLs) {
      purl.qualifiers = undefined
      purl.subpath = undefined
    }

    return purl
  }

  private finalizePathProperties (rootPath: any, components: IterableIterator<Models.Component>): void {
    if (typeof rootPath !== 'string' || rootPath === '') {
      return
    }
    /* eslint-disable @typescript-eslint/unbound-method */
    // do not depend on `node:path.relative()` -- this would be runtime-dependent, not input-dependent
    const [relativePath, dirSep] = rootPath[0] === '/'
      ? [path.posix.relative, '/']
      : [path.win32.relative, '\\']
    /* eslint-enable @typescript-eslint/unbound-method */
    for (const component of components) {
      for (const property of component.properties) {
        if (property.name !== PropertyNames.PackageInstallPath) {
          continue
        }
        if (property.value === '') {
          component.properties.delete(property)
          continue
        }
        property.value = relativePath(rootPath, property.value).replace(dirSep, '/')
      }
    }
  }

  private * makeTools (): Generator<Models.Tool> {
    /* eslint-disable-next-line @typescript-eslint/no-var-requires */
    const packageJsonPaths = ['../package.json']

    const libs = [
      '@cyclonedx/cyclonedx-library'
    ].map(s => s.split('/', 2))
    const nodeModulePaths = require.resolve.paths('__some_none-native_package__') ?? []
    /* eslint-disable no-labels */
    libsLoop:
    for (const lib of libs) {
      for (const nodeModulePath of nodeModulePaths) {
        const packageJsonPath = path.resolve(nodeModulePath, ...lib, 'package.json')
        if (existsSync(packageJsonPath)) {
          packageJsonPaths.push(packageJsonPath)
          continue libsLoop
        }
      }
    }
    /* eslint-enable no-labels */

    for (const packageJsonPath of packageJsonPaths) {
      /* eslint-disable-next-line @typescript-eslint/no-var-requires */
      const packageData = require(packageJsonPath)
      normalizePackageData(packageData /* add debug for warnings? */)
      const tool = this.toolBuilder.makeTool(packageData)
      if (tool !== undefined) {
        yield tool
      }
    }
  }
}

class DummyComponent extends Models.Component {
  constructor (type: Models.Component['type'], name: Models.Component['name']) {
    super(type, `DummyComponent.${name}`, {
      bomRef: `DummyComponent.${name}`,
      description: `This is a dummy component "${name}" that fills the gap where the actual built failed.`
    })
  }
}

type PTree = Map<string, PTree>

export class TreeBuilder {
  fromPaths (paths: Set<string>, dirSeparator: string): PTree {
    const tree: PTree = new Map(Array.from(paths, p => [p + dirSeparator, new Map()]))
    this.nestPT(tree)
    this.renderPR(tree, '')
    return tree
  }

  private renderPR (tree: PTree, pref: string): void {
    for (const [p, pTree] of [...tree.entries()]) {
      tree.delete(p)
      const pFull = pref + p
      this.renderPR(pTree, pFull)
      tree.set(pFull.slice(undefined, -1), pTree)
    }
  }

  private nestPT (tree: PTree): void {
    if (tree.size < 2) {
      // nothing to compare ...
      return
    }
    for (const a of tree.keys()) {
      for (const [b, bTree] of tree) {
        if (a === b) {
          continue
        }
        if (b.startsWith(a)) {
          (tree.get(a) as PTree).set(b.slice(a.length), bTree)
          tree.delete(b)
        }
      }
    }
    for (const c of tree.values()) {
      this.nestPT(c)
    }
  }
}

const structuredClonePolyfill: <T>(value: T) => T = typeof structuredClone === 'function'
  ? structuredClone
  : function (value) { return JSON.parse(JSON.stringify(value)) }
