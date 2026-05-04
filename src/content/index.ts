import './index.css'

import { SESSION_KEY, CLASS_KEY, ADVANCE_KEY } from '@/constant'
import { matchWildcardUrls } from '@/utils'

// 💡 关键修复：在 document_start 时立即同步检查 sessionStorage，防止白屏闪烁
;(function applyEarlyTheme() {
  const isDark = sessionStorage.getItem(SESSION_KEY) === 'true'
  if (isDark) {
    const root = document.documentElement
    root.classList.add(CLASS_KEY)

    // 💡 强制禁用初始过渡，确保应用是瞬间的
    const style = document.createElement('style')
    style.id = 'dimmer-initial-style'
    style.innerHTML = `
      html, html * { 
        transition: none !important; 
      }
    `
    root.appendChild(style)

    // 立即尝试从 sessionStorage 获取配置并应用初步滤镜
    const configStr = sessionStorage.getItem(ADVANCE_KEY)
    if (configStr) {
      try {
        const config = JSON.parse(configStr)
        const filters = [
          `brightness(${config.brightness * 10}%)`,
          `contrast(${config.contrast / 10})`,
          `grayscale(${config.grayscale * 10}%)`,
          `sepia(${config.sepia * 10}%)`,
          `invert(100)`,
          `hue-rotate(180deg)`,
        ].join(' ')
        root.style.filter = filters
      } catch (e) {
        root.style.filter = 'invert(100) hue-rotate(180deg)'
      }
    } else {
      root.style.filter = 'invert(100) hue-rotate(180deg)'
    }

    // 在下一帧移除强制禁用过渡的样式，以便后续手动切换时能正常过渡
    requestAnimationFrame(() => {
      setTimeout(() => {
        style.remove()
      }, 100)
    })
  }
})()

type Filter = Record<string, string>

let htmlFilter: Filter = {}

// 💡 使用 WeakSet 记录已检查过的元素，避免重复 getComputedStyle 影响性能
const checkedElements = new WeakSet<Element>()

const theme = {
  '1': {
    invert: '100',
    ['hue-rotate']: '180deg',
  },
  '0': {
    invert: '0',
    ['hue-rotate']: '0deg',
  },
}

const convertFilterToObject = (filterValue: string) => {
  const filters = filterValue.split(' ')
  const result: Filter = {}
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i]
    const openParenIndex = filter.indexOf('(')
    const name = filter.substring(0, openParenIndex)
    const value = filter.substring(openParenIndex + 1, filter.length - 1)
    result[name] = value
  }
  return result
}

const objectToFilterString = (obj: Filter) => {
  return Object.entries(obj)
    .map(([name, value]) => `${name}(${value})`)
    .join(' ')
}

const setFilter = (data: Record<string, number>, passive: Boolean) => {
  if (Object.keys(data).length === 0) return
  const { brightness, contrast, grayscale, sepia } = data
  const root = document.documentElement
  if (root) {
    htmlFilter = {
      ...htmlFilter,
      brightness: `${brightness * 10}%`,
      contrast: `${contrast / 10}`,
      grayscale: `${grayscale * 10}%`,
      sepia: `${sepia * 10}%`,
    }
    if (!passive) {
      const t = { brightness, contrast, grayscale, sepia }
      sessionStorage.setItem(ADVANCE_KEY, JSON.stringify(t))
      chrome.runtime.sendMessage({
        action: 'setGlobal',
        state: {
          config: t,
        },
      })
    }
    root.style.filter = `${objectToFilterString(htmlFilter)}`
  }
}

const readableConfig = (data: Record<string, number>): Record<string, string> => {
  const KEY_MAP: Map<string, number> = new Map([
    ['brightness', 10],
    ['contrast', 0.1],
    ['grayscale', 10],
    ['sepia', 10],
  ])
  const TAIL_MAP: Map<string, string> = new Map([
    ['brightness', '%'],
    ['contrast', ''],
    ['grayscale', '%'],
    ['sepia', '%'],
  ])
  const res: Record<string, string> = {}
  Object.keys(data).forEach((key) => {
    const mappedValue = KEY_MAP.get(key) || 1
    res[key] = `${data[key] * mappedValue}${TAIL_MAP.get(key) || ''}`
  })
  return res
}

// 💡 性能优化：使用队列分批处理元素，避免主线程卡死
const pendingNodes: Element[] = []
const nodesInQueue = new WeakSet<Element>() // 记录已在队列中的元素
let isProcessing = false

const processNextBatch = () => {
  const isDark = document.documentElement.classList.contains(CLASS_KEY)
  if (!isDark || pendingNodes.length === 0) {
    pendingNodes.length = 0
    isProcessing = false
    return
  }

  isProcessing = true
  const startTime = performance.now()
  const BATCH_TIME_LIMIT = 8 // 限制每批处理时间为 8ms

  while (pendingNodes.length > 0 && performance.now() - startTime < BATCH_TIME_LIMIT) {
    const node = pendingNodes.shift()
    if (!node) continue
    nodesInQueue.delete(node)

    if (checkedElements.has(node)) continue

    // 基础过滤：跳过一些肯定没有背景图的标签
    const skipTags = [
      'SCRIPT',
      'STYLE',
      'LINK',
      'META',
      'TITLE',
      'NOSCRIPT',
      'BR',
      'HR',
      'TEMPLATE',
      'CANVAS',
      'SVG',
    ]
    if (skipTags.includes(node.tagName)) {
      checkedElements.add(node)
      continue
    }

    const style = window.getComputedStyle(node)
    const bgImage = style.backgroundImage
    if (bgImage && bgImage !== 'none' && bgImage.includes('url(')) {
      node.classList.add('dimmerInvert')
    }
    checkedElements.add(node)
  }

  if (pendingNodes.length > 0) {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(processNextBatch)
    } else {
      setTimeout(processNextBatch, 16)
    }
  } else {
    isProcessing = false
  }
}

// 💡 性能优化：使用 IntersectionObserver 仅处理可见区域的元素
const intersectionObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const el = entry.target as Element
        if (!checkedElements.has(el)) {
          pendingNodes.push(el)
          nodesInQueue.add(el)
          if (!isProcessing) processNextBatch()
        }
        // 处理完后停止观察该元素，除非它可能会动态改变背景（属性观察会重新处理）
        intersectionObserver.unobserve(el)
      }
    })
  },
  {
    rootMargin: '200px', // 提前 200px 开始处理，减少视觉延迟
  },
)

/**
 * 💡 关键修复：识别并反转背景图片颜色
 * 优化：结合 IntersectionObserver 和分批异步处理
 */
const identifyBgElements = (root: Node = document.body) => {
  const isDark = document.documentElement.classList.contains(CLASS_KEY)
  if (!isDark || !root) return

  const processElement = (el: Element) => {
    if (checkedElements.has(el) || nodesInQueue.has(el)) return

    // 基础过滤：跳过肯定没有背景图的标签
    const skipTags = [
      'SCRIPT',
      'STYLE',
      'LINK',
      'META',
      'TITLE',
      'NOSCRIPT',
      'BR',
      'HR',
      'TEMPLATE',
      'CANVAS',
      'SVG',
    ]
    if (skipTags.includes(el.tagName)) {
      checkedElements.add(el)
      return
    }

    // 💡 核心优化：不立即检查样式，而是加入观察列表
    // 只有进入视口的元素才真正调用 getComputedStyle
    intersectionObserver.observe(el)
  }

  if (root instanceof Element) {
    processElement(root)
  }

  // 遍历子节点
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const el = node as Element
      if (checkedElements.has(el) || nodesInQueue.has(el)) return NodeFilter.FILTER_REJECT
      if (
        el.tagName === 'IMG' ||
        el.tagName === 'VIDEO' ||
        el.tagName === 'SCRIPT' ||
        el.tagName === 'STYLE'
      ) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let currentNode = walker.nextNode() as Element
  while (currentNode) {
    processElement(currentNode)
    currentNode = walker.nextNode() as Element
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { info, data = {} } = request
  if (info === 'changeMode' || info === 'toggleMode') {
    const root = document.documentElement
    // 💡 手动切换时添加过渡类，实现丝滑切换
    root.classList.add('dimmerTransition')

    chrome.runtime.sendMessage({ action: 'getGlobal' }, (response) => {
      const state = response?.state || {}
      const isGlobal = state.isGlobal

      // 💡 优先使用消息中传递的状态，否则使用后台返回的状态
      const targetIsDark = data.isDark !== undefined ? data.isDark : state.isDark

      if (isGlobal) {
        if (targetIsDark && data.exclude !== true) {
          root.classList.add(CLASS_KEY)
          sessionStorage.setItem(SESSION_KEY, 'true')
          htmlFilter = {
            ...htmlFilter,
            ...theme['1'],
          }
        } else {
          root.classList.remove(CLASS_KEY)
          sessionStorage.setItem(SESSION_KEY, 'false')
          htmlFilter = {
            ...htmlFilter,
            ...theme['0'],
          }
        }
      } else {
        // 非全局模式下的切换
        const currentlyDark = root.classList.contains(CLASS_KEY)
        const nextDark = data.isDark !== undefined ? data.isDark : !currentlyDark

        if (nextDark) {
          root.classList.add(CLASS_KEY)
          sessionStorage.setItem(SESSION_KEY, 'true')
          htmlFilter = {
            ...htmlFilter,
            ...theme['1'],
          }
        } else {
          root.classList.remove(CLASS_KEY)
          sessionStorage.setItem(SESSION_KEY, 'false')
          htmlFilter = {
            ...htmlFilter,
            ...theme['0'],
          }
        }
      }
      root.style.filter = `${objectToFilterString(htmlFilter)}`

      // 💡 切换模式后识别背景图片
      if (document.body) {
        identifyBgElements(document.body)
      }
    })
    if (info === 'toggleMode') {
      chrome.runtime.sendMessage({ action: 'updatePopupConfig' })
    }
  }
  if (info === 'getMode') {
    const has = sessionStorage.getItem(SESSION_KEY) === 'true'
    const data = JSON.parse(sessionStorage.getItem(ADVANCE_KEY) || '{}')
    sendResponse({
      has,
      data,
    })
  }
  if (info === 'changeConfig') {
    document.documentElement.classList.add('dimmerTransition')
    setFilter(data, false)
  }
})

const checkIsFullScreen = () => {
  document.addEventListener('fullscreenchange', () => {
    const hasVideo = window.document.fullscreenElement?.querySelector('video')
    if (hasVideo) {
      const root = document.documentElement
      root?.classList.remove(CLASS_KEY)
      sessionStorage.setItem(SESSION_KEY, 'false')
    }
  })
}

/**
 * 💡 关键修复：解决知乎等站点在开启滤镜后，Modal 关闭但 body overflow: hidden 状态不恢复的问题
 */
const fixScrollIssue = () => {
  const isZhihu = window.location.hostname.includes('zhihu.com')

  // 💡 进一步优化：对 MutationObserver 的处理进行防抖，合并频繁的 DOM 变动
  let mutationTimeout: number | null = null
  const pendingMutations: Set<Element> = new Set()

  const checkAndRestoreScroll = (mutations?: MutationRecord[]) => {
    const root = document.documentElement
    const isDark = root.classList.contains(CLASS_KEY)
    if (!isDark) return

    // 处理背景图片识别
    if (mutations) {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof Element) pendingMutations.add(node)
          })
        } else if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          const el = mutation.target
          if (mutation.attributeName === 'class' && el.classList.contains('dimmerInvert')) continue
          if (el === root) continue
          checkedElements.delete(el)
          pendingMutations.add(el)
        }
      }

      if (mutationTimeout) clearTimeout(mutationTimeout)
      mutationTimeout = window.setTimeout(() => {
        // 💡 顶级节点过滤：如果一个节点是另一个节点的子节点，则只处理父节点
        const topLevelNodes = Array.from(pendingMutations).filter((node) => {
          let parent = node.parentElement
          while (parent) {
            if (pendingMutations.has(parent)) return false
            parent = parent.parentElement
          }
          return true
        })

        topLevelNodes.forEach((node) => identifyBgElements(node))
        pendingMutations.clear()
        mutationTimeout = null
      }, 150) // 150ms 防抖，平衡响应速度和性能
    }

    if (!isZhihu) return
    const body = document.body
    if (!body || !root) return

    // 检查是否有任何弹窗或大图查看器
    const selectors = [
      '.Image-viewer',
      '.Modal-wrapper',
      '.Lightbox',
      '[role="dialog"]',
      '[class*="Modal"]',
      '[class*="viewer"]',
      '.css-1738258',
      '.css-1909605',
    ]
    const hasModal = !!document.querySelector(selectors.join(', '))

    if (!hasModal) {
      const bodyStyle = window.getComputedStyle(body)
      const rootStyle = window.getComputedStyle(root)

      if (bodyStyle.overflow === 'hidden' || rootStyle.overflow === 'hidden') {
        const restore = () => {
          if (!document.querySelector(selectors.join(', '))) {
            body.style.setProperty('overflow', 'auto', 'important')
            root.style.setProperty('overflow', 'auto', 'important')
            if (bodyStyle.position === 'fixed') {
              body.style.setProperty('position', 'static', 'important')
            }
            window.dispatchEvent(new Event('resize'))
          }
        }
        restore()
        setTimeout(restore, 500)
      }
    }
  }

  const observer = new MutationObserver(checkAndRestoreScroll)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
    childList: true,
    subtree: true,
  })

  window.addEventListener(
    'click',
    () => {
      setTimeout(() => checkAndRestoreScroll(), 100)
    },
    true,
  )
}

function main() {
  chrome.runtime.sendMessage({ action: 'getGlobal' }, (response) => {
    if (response) {
      const state = response.state
      const { isDark, isGlobal, config, excludeUrls } = state
      const root = document.documentElement
      if (isGlobal) {
        const isExcluded = matchWildcardUrls(window.location.href, excludeUrls)
        const shouldBeDark = isDark && !isExcluded

        // 💡 同步更新 sessionStorage，供下次刷新时 applyEarlyTheme 使用
        sessionStorage.setItem(SESSION_KEY, shouldBeDark ? 'true' : 'false')
        sessionStorage.setItem(ADVANCE_KEY, JSON.stringify(config))

        if (shouldBeDark) {
          root.classList.add(CLASS_KEY)
          htmlFilter = {
            ...htmlFilter,
            ...readableConfig(config),
            ...theme['1'],
          }
        } else {
          root.classList.remove(CLASS_KEY)
          htmlFilter = {
            ...htmlFilter,
            ...readableConfig(config),
            ...theme['0'],
          }
        }
      } else {
        const config = JSON.parse(sessionStorage.getItem(ADVANCE_KEY) || '{}')
        const t = sessionStorage.getItem(SESSION_KEY)
        if (t === 'true') {
          root.classList.add(CLASS_KEY)
          htmlFilter = {
            ...htmlFilter,
            ...readableConfig(config),
            ...theme['1'],
          }
        } else {
          root.classList.remove(CLASS_KEY)
          htmlFilter = {
            ...htmlFilter,
            ...readableConfig(config),
            ...theme['0'],
          }
        }
      }
      root.style.filter = `${objectToFilterString(htmlFilter)}`

      // 💡 切换模式后识别背景图片
      if (document.body) {
        identifyBgElements(document.body)
      }
    }
  })
  checkIsFullScreen()
  fixScrollIssue()

  // 💡 初始识别背景图片
  if (document.body) {
    identifyBgElements(document.body)
  }
}

main()
