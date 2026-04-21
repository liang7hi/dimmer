import './index.css'

import { SESSION_KEY, CLASS_KEY, ADVANCE_KEY } from '@/constant'
import { matchWildcardUrls } from '@/utils'

//  关键修复：在 document_start 时立即同步检查 sessionStorage，防止白屏闪烁
;(function applyEarlyTheme() {
  const isDark = sessionStorage.getItem(SESSION_KEY) === 'true'
  if (isDark) {
    const root = document.documentElement
    root.classList.add(CLASS_KEY)

    //  强制禁用初始过渡，确保应用是瞬间的
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

//  使用 WeakSet 记录已检查过的元素，避免重复 getComputedStyle 影响性能
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

/**
 *  关键修复：识别并反转背景图片颜色
 * 优化：使用 WeakSet 缓存，并仅在必要时检查
 */
const identifyBgElements = (nodes: NodeList | HTMLCollection | Element[]) => {
  const isDark = document.documentElement.classList.contains(CLASS_KEY)
  if (!isDark) return

  const checkElement = (el: Element) => {
    if (
      el.tagName === 'IMG' ||
      el.tagName === 'VIDEO' ||
      el.tagName === 'SCRIPT' ||
      el.tagName === 'STYLE'
    )
      return

    // 如果元素已经在 WeakSet 中且没有 class 变化（通过 MutationObserver 处理），则跳过
    if (checkedElements.has(el) && el.classList.contains('dimmerInvert')) return

    const style = window.getComputedStyle(el)
    const bgImage = style.backgroundImage

    if (bgImage && bgImage !== 'none' && bgImage.includes('url(')) {
      if (!el.classList.contains('dimmerInvert')) {
        el.classList.add('dimmerInvert')
      }
    } else {
      if (el.classList.contains('dimmerInvert')) {
        el.classList.remove('dimmerInvert')
      }
    }
    checkedElements.add(el)
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node instanceof Element) {
      checkElement(node)
      // 性能优化：不使用 querySelectorAll('*')，仅扫描具有 style 或特定属性的子元素
      const children = node.getElementsByTagName('*')
      for (let j = 0; j < children.length; j++) {
        const child = children[j]
        // 简单过滤，减少 getComputedStyle 调用
        if (child.hasAttribute('style') || child.classList.length > 0) {
          checkElement(child)
        }
      }
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { info, data = {} } = request
  if (info === 'changeMode' || info === 'toggleMode') {
    const root = document.documentElement
    //  手动切换时添加过渡类，实现丝滑切换
    root.classList.add('dimmerTransition')

    chrome.runtime.sendMessage({ action: 'getGlobal' }, (response) => {
      const state = response?.state || {}
      const isGlobal = state.isGlobal

      //  优先使用消息中传递的状态，否则使用后台返回的状态
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

      //  切换模式后识别背景图片
      if (document.body) {
        identifyBgElements([document.body])
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
 *  关键修复：解决知乎等站点在开启滤镜后，Modal 关闭但 body overflow: hidden 状态不恢复的问题
 */
const fixScrollIssue = () => {
  const isZhihu = window.location.hostname.includes('zhihu.com')

  const checkAndRestoreScroll = (mutations?: MutationRecord[]) => {
    const root = document.documentElement
    const isDark = root.classList.contains(CLASS_KEY)
    if (!isDark) return

    // 处理背景图片识别
    if (mutations) {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          identifyBgElements(mutation.addedNodes)
        } else if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          //  性能优化：仅当 style 或 class 变化，且不是由我们自己添加的类引起时才检查
          if (
            mutation.attributeName === 'class' &&
            mutation.target.classList.contains('dimmerInvert')
          ) {
            continue
          }
          // 重新加入 WeakSet 以便下次检查
          checkedElements.delete(mutation.target)
          identifyBgElements([mutation.target])
        }
      }
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

        //  同步更新 sessionStorage，供下次刷新时 applyEarlyTheme 使用
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

      //  切换模式后识别背景图片
      if (document.body) {
        identifyBgElements([document.body])
      }
    }
  })
  checkIsFullScreen()
  fixScrollIssue()

  //  初始识别背景图片
  if (document.body) {
    identifyBgElements([document.body])
  }
}

main()
