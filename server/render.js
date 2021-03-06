import {join} from 'path'
import {createElement} from 'react'
import {renderToString, renderToStaticMarkup} from 'react-dom/server'
import send from 'send'
import generateETag from 'etag'
import fresh from 'fresh'
// import requirePage from './require'
// import { Router } from '../lib/router'
import {loadGetInitialProps, isResSent} from '../lib/utils'
import {getAvailableChunks} from './utils'
import Head, {defaultHead} from '../lib/head'
import App from '../lib/app'
import ErrorDebug from '../lib/error-debug'
import {flushChunks, clearChunks} from '../lib/dynamic'
import * as DvaCore from '../lib/dva'
import {createServerRouter} from '../lib/router'

const logger = console

export async function render (req, res, pathname, query, opts) {
  const html = await renderToHTML(req, res, pathname, query, opts)
  sendHTML(req, res, html, req.method, opts)
}

export function renderToHTML (req, res, pathname, query, opts) {
  return doRender(req, res, pathname, query, opts)
}

export async function renderError (err, req, res, pathname, query, opts) {
  const html = await renderErrorToHTML(err, req, res, query, opts)
  sendHTML(req, res, html, req.method, opts)
}

export function renderErrorToHTML (err, req, res, pathname, query, opts = {}) {
  return doRender(req, res, pathname, query, {...opts, err, page: '/_error'})
}

async function doRender (req, res, pathname, query, {
  err,
  page,
  serverRender,
  ComponentPath,
  buildId,
  hotReloader,
  assetPrefix,
  runtimeConfig,
  availableChunks,
  dist,
  dir = process.cwd(),
  dev = false,
  staticMarkup = false,
  joyExport = false
} = {}) {
  console.log(`> start doRender, pathname:${pathname}, err:${err || null}`)
  page = page || pathname

  // 暂时不需要监听页面的编译情况 lane 2017-12-05
  // if (hotReloader) { // In dev mode we use on demand entries to compile the page before rendering
  //   await ensurePage(page, { dir, hotReloader })
  // }

  const documentPath = join(dir, dist, 'dist', 'bundles', 'pages', '_document')

  let Document = require(documentPath)

  Document = Document.default || Document
  const asPath = req.url
  const ctx = {err, req, res, pathname, query, asPath}
  // const props = await loadGetInitialProps(Component, ctx)
  const props = {}

  // the response might be finshed on the getinitialprops call
  if (isResSent(res)) return

  const renderPage = async (enhancer = Comp => Comp) => {
    // const Router = new Router(pathname, query, asPath)
    const Router = createServerRouter(pathname, query)

    const createApp = function (Component, appProps) {
      return createElement(App, {
        Component,
        props,
        Router,
        ...appProps
      })
    }
    const requireComp = function () {
      let Component = require(ComponentPath)
      Component = Component.default || Component
      return enhancer(Component)
    }

    const render = staticMarkup ? renderToStaticMarkup : renderToString
    let html
    let head
    let errorHtml = ''
    let initStoreState
    try {
      if (err && dev) {
        errorHtml = render(createElement(ErrorDebug, {error: err}))
      } else if (err) {
        if (serverRender) {
          const Component = requireComp()
          errorHtml = render(createApp(Component, {isComponentDidPrepare: false}))
        } else {
          html = ''
          clearChunks()
        }
      } else {
        if (serverRender) {
          const Component = requireComp()
          const dva = DvaCore.create({})
          dva.start()
          // 第一次渲染，执行当前页面中所有组件的componentWillMount事件，dispatch redux的action，开始执行操作，
          // 等所有异步操作完成以后，redux state的状态已更新完成后，执行第二次渲染
          renderToStaticMarkup(createApp(Component, {dva, isComponentDidPrepare: false}))

          await dva.prepareManager.waitAllPrepareFinished()
          await dva._store.dispatch({
            type: '@@endAsyncBatch'
          })
          console.log('> app has prepared')
          clearChunks()
          const app = createApp(Component, {dva, isComponentDidPrepare: true})
          // 第二次渲染，此时store的state已经获取数据完成
          html = render(app)
          initStoreState = dva._store.getState()
          console.log('> server render has finished')
        } else {
          html = ''
          clearChunks()
        }
      }
    } finally {
      head = Head.rewind() || defaultHead()
    }
    const chunks = loadChunks({dev, dir, dist, availableChunks})
    return {html, head, errorHtml, chunks, initStoreState}
  }

  const docProps = await loadGetInitialProps(Document, {...ctx, renderPage})

  if (isResSent(res)) return

  if (!Document.prototype || !Document.prototype.isReactComponent) throw new Error('_document.js is not exporting a React element')
  const doc = createElement(Document, {
    __SYMPHONY_DATA__: {
      props,
      page, // the rendered page
      pathname, // the requested path
      query,
      buildId,
      assetPrefix,
      runtimeConfig,
      joyExport,
      err: (err) ? serializeError(dev, err) : null,
      initStoreState: docProps.initStoreState
    },
    dev,
    dir,
    staticMarkup,
    ...docProps
  })

  return '<!DOCTYPE html>' + renderToStaticMarkup(doc)
}

export async function renderScriptError (req, res, page, error) {
  // Asks CDNs and others to not to cache the errored page
  res.setHeader('Cache-Control', 'no-store, must-revalidate')

  if (error.code === 'ENOENT') {
    res.statusCode = 404
    res.end('404 - Not Found')
    return
  }

  logger.error(error.stack)
  res.statusCode = 500
  res.end('500 - Internal Error')
}

export function sendHTML (req, res, html, method, {dev}) {
  if (isResSent(res)) return
  const etag = generateETag(html)

  if (fresh(req.headers, {etag})) {
    res.statusCode = 304
    res.end()
    return
  }

  if (dev) {
    // In dev, we should not cache pages for any reason.
    // That's why we do this.
    res.setHeader('Cache-Control', 'no-store, must-revalidate')
  }

  res.setHeader('ETag', etag)
  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
  }
  res.setHeader('Content-Length', Buffer.byteLength(html))
  res.end(method === 'HEAD' ? null : html)
}

export function sendJSON (res, obj, method) {
  if (isResSent(res)) return

  const json = JSON.stringify(obj)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Length', Buffer.byteLength(json))
  res.end(method === 'HEAD' ? null : json)
}

function errorToJSON (err) {
  const {name, message, stack} = err
  const json = {name, message, stack}

  if (err.module) {
    // rawRequest contains the filename of the module which has the error.
    const {rawRequest} = err.module
    json.module = {rawRequest}
  }

  return json
}

function serializeError (dev, err) {
  if (dev) {
    return errorToJSON(err)
  }

  return {message: '500 - Internal Server Error.'}
}

export function serveStatic (req, res, path) {
  return new Promise((resolve, reject) => {
    send(req, path)
      .on('directory', () => {
        // We don't allow directories to be read.
        const err = new Error('No directory access')
        err.code = 'ENOENT'
        reject(err)
      })
      .on('error', reject)
      .pipe(res)
      .on('finish', resolve)
  })
}

// async function ensurePage (page, {dir, hotReloader}) {
//   if (page === '/_error') return
//
//   await hotReloader.ensurePage(page)
// }

function loadChunks ({dev, dir, dist, availableChunks}) {
  const flushedChunks = flushChunks()
  const response = {
    names: [],
    filenames: []
  }

  if (dev) {
    availableChunks = getAvailableChunks(dir, dist)
  }

  for (var chunk of flushedChunks) {
    const filename = availableChunks[chunk]
    if (filename) {
      response.names.push(chunk)
      response.filenames.push(filename)
    }
  }

  return response
}
