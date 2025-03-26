import { AllPublishOptions, newError, PackageFileInfo, BlockMap, CURRENT_APP_PACKAGE_FILE_NAME, CURRENT_APP_INSTALLER_FILE_NAME } from "builder-util-runtime"
import * as path from "path"
import { AppAdapter } from "./AppAdapter"
import { DownloadUpdateOptions } from "./AppUpdater"
import { BaseUpdater, InstallOptions } from "./BaseUpdater"
import { DifferentialDownloaderOptions } from "./differentialDownloader/DifferentialDownloader"
import { FileWithEmbeddedBlockMapDifferentialDownloader } from "./differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader"
import { GenericDifferentialDownloader } from "./differentialDownloader/GenericDifferentialDownloader"
import { DOWNLOAD_PROGRESS, ResolvedUpdateFileInfo, verifyUpdateCodeSignature } from "./main"
import { blockmapFiles } from "./util"
import { findFile, Provider } from "./providers/Provider"
import { unlink } from "fs-extra"
import { verifySignature } from "./windowsExecutableCodeSignatureVerifier"
import { URL } from "url"
import { gunzipSync } from "zlib"

export class NsisUpdater extends BaseUpdater {
  /**
   * Specify custom install directory path
   *
   */
  installDirectory?: string

  constructor(options?: AllPublishOptions | null, app?: AppAdapter) {
    super(options, app)
  }

  protected _verifyUpdateCodeSignature: verifyUpdateCodeSignature = (publisherNames: Array<string>, unescapedTempUpdateFile: string) =>
    verifySignature(publisherNames, unescapedTempUpdateFile, this._logger)

  /**
   * The verifyUpdateCodeSignature. You can pass [win-verify-signature](https://github.com/beyondkmp/win-verify-trust) or another custom verify function: ` (publisherName: string[], path: string) => Promise<string | null>`.
   * The default verify function uses [windowsExecutableCodeSignatureVerifier](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/windowsExecutableCodeSignatureVerifier.ts)
   */
  get verifyUpdateCodeSignature(): verifyUpdateCodeSignature {
    return this._verifyUpdateCodeSignature
  }

  set verifyUpdateCodeSignature(value: verifyUpdateCodeSignature) {
    if (value) {
      this._verifyUpdateCodeSignature = value
    }
  }

  /*** @private */
  protected async doDownloadUpdate(downloadUpdateOptions: DownloadUpdateOptions): Promise<Array<string>> {
    const provider = downloadUpdateOptions.updateInfoAndProvider.provider
    const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE
    // Look for either "portable" or "setup" exe based on current mode
    const not = isPortable ? ["setup"] : ["USB"]
    console.log("INFO: ", downloadUpdateOptions.updateInfoAndProvider.info)
    const fileInfo = findFile(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), "exe", not)!

    this._logger.info(`Downloading update: ${fileInfo.url}, isPortable: ${isPortable}, not: ${not}`)
    return this.executeDownload({
      fileExtension: "exe",
      downloadUpdateOptions,
      fileInfo,
      task: async (destinationFile, downloadOptions, packageFile, removeTempDirIfAny) => {
        const packageInfo = fileInfo.packageInfo
        const isWebInstaller = packageInfo != null && packageFile != null

        if (isPortable) {
          await this.httpExecutor.download(fileInfo.url, destinationFile, downloadOptions)
          return
        }

        if (isWebInstaller && downloadUpdateOptions.disableWebInstaller) {
          throw newError(
            `Unable to download new version ${downloadUpdateOptions.updateInfoAndProvider.info.version}. Web Installers are disabled`,
            "ERR_UPDATER_WEB_INSTALLER_DISABLED"
          )
        }
        if (!isWebInstaller && !downloadUpdateOptions.disableWebInstaller) {
          this._logger.warn(
            "disableWebInstaller is set to false, you should set it to true if you do not plan on using a web installer. This will default to true in a future version."
          )
        }
        if (isWebInstaller || (await this.differentialDownloadInstaller(fileInfo, downloadUpdateOptions, destinationFile, provider))) {
          await this.httpExecutor.download(fileInfo.url, destinationFile, downloadOptions)
        }

        const signatureVerificationStatus = await this.verifySignature(destinationFile)
        if (signatureVerificationStatus != null) {
          await removeTempDirIfAny()
          // noinspection ThrowInsideFinallyBlockJS
          throw newError(
            `New version ${downloadUpdateOptions.updateInfoAndProvider.info.version} is not signed by the application owner: ${signatureVerificationStatus}`,
            "ERR_UPDATER_INVALID_SIGNATURE"
          )
        }

        if (isWebInstaller) {
          if (await this.differentialDownloadWebPackage(downloadUpdateOptions, packageInfo, packageFile, provider)) {
            try {
              await this.httpExecutor.download(new URL(packageInfo.path), packageFile, {
                headers: downloadUpdateOptions.requestHeaders,
                cancellationToken: downloadUpdateOptions.cancellationToken,
                sha512: packageInfo.sha512,
              })
            } catch (e: any) {
              try {
                await unlink(packageFile)
              } catch (ignored) {
                // ignore
              }

              throw e
            }
          }
        }
      },
    })
  }

  // $certificateInfo = (Get-AuthenticodeSignature 'xxx\yyy.exe'
  // | where {$_.Status.Equals([System.Management.Automation.SignatureStatus]::Valid) -and $_.SignerCertificate.Subject.Contains("CN=siemens.com")})
  // | Out-String ; if ($certificateInfo) { exit 0 } else { exit 1 }
  private async verifySignature(tempUpdateFile: string): Promise<string | null> {
    let publisherName: Array<string> | string | null
    try {
      publisherName = (await this.configOnDisk.value).publisherName
      if (publisherName == null) {
        return null
      }
    } catch (e: any) {
      if (e.code === "ENOENT") {
        // no app-update.yml
        return null
      }
      throw e
    }
    return await this._verifyUpdateCodeSignature(Array.isArray(publisherName) ? publisherName : [publisherName], tempUpdateFile)
  }

  protected doInstall(options: InstallOptions): boolean {
    const args = ["--updated"]
    const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE

    this._logger.info(`Is portable  ${isPortable}`)
    if (isPortable) {
      return this.installPortable()
    }

    if (options.isSilent) {
      args.push("/S")
    }

    if (options.isForceRunAfter) {
      args.push("--force-run")
    }

    if (this.installDirectory) {
      // maybe check if folder exists
      args.push(`/D=${this.installDirectory}`)
    }

    const packagePath = this.downloadedUpdateHelper == null ? null : this.downloadedUpdateHelper.packageFile
    if (packagePath != null) {
      // only = form is supported
      args.push(`--package-file=${packagePath}`)
    }

    const callUsingElevation = (): void => {
      this.spawnLog(path.join(process.resourcesPath!, "elevate.exe"), [options.installerPath].concat(args)).catch(e => this.dispatchError(e))
    }

    if (options.isAdminRightsRequired) {
      this._logger.info("isAdminRightsRequired is set to true, run installer using elevate.exe")
      callUsingElevation()
      return true
    }

    this.spawnLog(options.installerPath, args).catch((e: Error) => {
      // https://github.com/electron-userland/electron-builder/issues/1129
      // Node 8 sends errors: https://nodejs.org/dist/latest-v8.x/docs/api/errors.html#errors_common_system_errors
      const errorCode = (e as NodeJS.ErrnoException).code
      this._logger.info(
        `Cannot run installer: error code: ${errorCode}, error message: "${e.message}", will be executed again using elevate if EACCES, and will try to use electron.shell.openItem if ENOENT`
      )
      if (errorCode === "UNKNOWN" || errorCode === "EACCES") {
        callUsingElevation()
      } else if (errorCode === "ENOENT") {
        require("electron")
          .shell.openPath(options.installerPath)
          .catch((err: Error) => this.dispatchError(err))
      } else {
        this.dispatchError(e)
      }
    })
    return true
  }

  private installPortable(): boolean {
    const installerPath = this.installerPath
    if (installerPath == null) {
      this.dispatchError(new Error("No valid update available, can't quit and install"))
      return false
    }

    // Get current executable path
    const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_FILE
    if (!portableExecutableDir) {
      throw newError("PORTABLE_EXECUTABLE_DIR env is not defined", "ERR_UPDATER_OLD_FILE_NOT_FOUND")
    }

    const appPath = path.dirname(portableExecutableDir)
    const backupPath = `${portableExecutableDir}.backup`
    const appBaseName = path.basename(portableExecutableDir)

    // Log paths
    this._logger.info(`Current executable path: ${portableExecutableDir}`)
    this._logger.info(`App path: ${appPath}`)
    this._logger.info(`Installer path: ${installerPath}`)

    try {
      const updateScript = path.join(appPath, "update.cmd")
      const scriptContent = [
        "@echo off",
        "setlocal enabledelayedexpansion",
        "set SUCCESS=0",
        "",
        "echo [Paths]",
        `echo Current exe: ${portableExecutableDir}`,
        `echo Backup path: ${backupPath}`,
        `echo New version: ${installerPath}`,
        "",
        `echo Waiting for ${appBaseName} to quit...`,
        ":wait_loop",
        `tasklist /FI "IMAGENAME eq ${appBaseName}" 2>NUL | find /I "${appBaseName}" >NUL`,
        "if %ERRORLEVEL% EQU 0 (",
        "  timeout /t 2 /nobreak >NUL",
        "  goto wait_loop",
        ")",
        "",
        "echo Creating backup...",
        `copy "${portableExecutableDir}" "${backupPath}" >NUL`,
        "if %ERRORLEVEL% NEQ 0 (",
        "  echo Failed to create backup!",
        "  exit /b 1",
        ")",
        "",
        "echo Moving new version...",
        `move /y "${installerPath}" "${portableExecutableDir}"`,
        "if %ERRORLEVEL% NEQ 0 (",
        "  echo Update failed! Restoring from backup...",
        `  move /y "${backupPath}" "${portableExecutableDir}"`,
        "  exit /b 1",
        ")",
        "",
        "echo Removing backup...",
        `del "${backupPath}" >NUL 2>&1`,
        "",
        "echo Starting new version...",
        `start "" "${portableExecutableDir}"`,
        "",
        "echo Update complete.",
        '(goto) 2>nul & del "%~f0" & exit /b 0',
      ].join("\r\n")

      // Log script content for debugging
      this._logger.info("Update script content:")
      this._logger.info(scriptContent)

      // Write update script
      require("fs").writeFileSync(updateScript, scriptContent)

      // Start update script minimized and exit current app
      this.spawnSyncLog("cmd", ["/c", "start", "/min", "", updateScript])
      this._logger.info("Update script started, quitting app...")
      this.app.quit()
      return true
    } catch (err) {
      this.dispatchError(err as Error)
      return false
    }
  }

  private async differentialDownloadInstaller(
    fileInfo: ResolvedUpdateFileInfo,
    downloadUpdateOptions: DownloadUpdateOptions,
    installerPath: string,
    provider: Provider<any>
  ): Promise<boolean> {
    try {
      if (this._testOnlyOptions != null && !this._testOnlyOptions.isUseDifferentialDownload) {
        return true
      }
      const blockmapFileUrls = blockmapFiles(fileInfo.url, this.app.version, downloadUpdateOptions.updateInfoAndProvider.info.version)
      this._logger.info(`Download block maps (old: "${blockmapFileUrls[0]}", new: ${blockmapFileUrls[1]})`)

      const downloadBlockMap = async (url: URL): Promise<BlockMap> => {
        const data = await this.httpExecutor.downloadToBuffer(url, {
          headers: downloadUpdateOptions.requestHeaders,
          cancellationToken: downloadUpdateOptions.cancellationToken,
        })

        if (data == null || data.length === 0) {
          throw new Error(`Blockmap "${url.href}" is empty`)
        }

        try {
          return JSON.parse(gunzipSync(data).toString())
        } catch (e: any) {
          throw new Error(`Cannot parse blockmap "${url.href}, error: ${e}`)
        }
      }

      const downloadOptions: DifferentialDownloaderOptions = {
        newUrl: fileInfo.url,
        oldFile: path.join(this.downloadedUpdateHelper!.cacheDir, CURRENT_APP_INSTALLER_FILE_NAME),
        logger: this._logger,
        newFile: installerPath,
        isUseMultipleRangeRequest: provider.isUseMultipleRangeRequest,
        requestHeaders: downloadUpdateOptions.requestHeaders,
        cancellationToken: downloadUpdateOptions.cancellationToken,
      }

      if (this.listenerCount(DOWNLOAD_PROGRESS) > 0) {
        downloadOptions.onProgress = it => this.emit(DOWNLOAD_PROGRESS, it)
      }

      const blockMapDataList = await Promise.all(blockmapFileUrls.map(u => downloadBlockMap(u)))
      await new GenericDifferentialDownloader(fileInfo.info, this.httpExecutor, downloadOptions).download(blockMapDataList[0], blockMapDataList[1])
      return false
    } catch (e: any) {
      this._logger.error(`Cannot download differentially, fallback to full download: ${e.stack || e}`)
      if (this._testOnlyOptions != null) {
        // test mode
        throw e
      }
      return true
    }
  }

  private async differentialDownloadWebPackage(
    downloadUpdateOptions: DownloadUpdateOptions,
    packageInfo: PackageFileInfo,
    packagePath: string,
    provider: Provider<any>
  ): Promise<boolean> {
    if (packageInfo.blockMapSize == null) {
      return true
    }

    try {
      const downloadOptions: DifferentialDownloaderOptions = {
        newUrl: new URL(packageInfo.path),
        oldFile: path.join(this.downloadedUpdateHelper!.cacheDir, CURRENT_APP_PACKAGE_FILE_NAME),
        logger: this._logger,
        newFile: packagePath,
        requestHeaders: this.requestHeaders,
        isUseMultipleRangeRequest: provider.isUseMultipleRangeRequest,
        cancellationToken: downloadUpdateOptions.cancellationToken,
      }

      if (this.listenerCount(DOWNLOAD_PROGRESS) > 0) {
        downloadOptions.onProgress = it => this.emit(DOWNLOAD_PROGRESS, it)
      }

      await new FileWithEmbeddedBlockMapDifferentialDownloader(packageInfo, this.httpExecutor, downloadOptions).download()
    } catch (e: any) {
      this._logger.error(`Cannot download differentially, fallback to full download: ${e.stack || e}`)
      // during test (developer machine mac or linux) we must throw error
      return process.platform === "win32"
    }
    return false
  }
}
