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
  const [root] = document.getElementsByTagName('html')
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { info, data = {} } = request
  if (info === 'changeMode' || info === 'toggleMode') {
    const root = document.documentElement
    // 💡 手动切换时添加过渡类，实现丝滑切换
    root.classList.add('dimmerTransition')

    chrome.runtime.sendMessage({ action: 'getGlobal' }, (response) => {
      const { isDark, isGlobal } = response?.state || {}
      const [root] = document.getElementsByTagName('html')
      if (isGlobal) {
        if (isDark && data.exclude !== true) {
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
        if (!root.classList.contains(CLASS_KEY)) {
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
      const root = document.querySelector('html')
      root?.classList.remove(CLASS_KEY)
      sessionStorage.setItem(SESSION_KEY, 'false')
    }
  })
}

/**
 * 💡 关键修复：解决知乎等站点在开启滤镜后，Modal 关闭但 body overflow: hidden 状态不恢复的问题
 * 原理：当 body 的 overflow 变为 hidden 时，监控页面上的 Modal 元素。
 * 如果 Modal 被移除但 overflow 仍然是 hidden，则手动恢复为 auto。
 */
const fixScrollIssue = () => {
  const isZhihu = window.location.hostname.includes('zhihu.com')
  if (!isZhihu) return

  const checkAndRestoreScroll = () => {
    const isDark = document.documentElement.classList.contains(CLASS_KEY)
    if (!isDark) return

    const body = document.body
    const html = document.documentElement
    if (!body || !html) return

    // 检查是否有任何弹窗或大图查看器
    // 扩大检测范围，知乎的评论图片预览器可能包含这些特征
    const selectors = [
      '.Image-viewer',
      '.Modal-wrapper',
      '.Lightbox',
      '[role="dialog"]',
      '[class*="Modal"]',
      '[class*="viewer"]',
      '.css-1738258',
      '.css-1909605', // 知乎某些版本下的弹窗类名
    ]
    const hasModal = !!document.querySelector(selectors.join(', '))

    if (!hasModal) {
      // 检查 body 和 html 的计算样式，因为 overflow 可能来自 class 而非 inline style
      const bodyStyle = window.getComputedStyle(body)
      const htmlStyle = window.getComputedStyle(html)

      if (bodyStyle.overflow === 'hidden' || htmlStyle.overflow === 'hidden') {
        // 发现被锁死，尝试强力恢复
        const restore = () => {
          // 再次确认 Modal 确实不在了
          if (!document.querySelector(selectors.join(', '))) {
            body.style.setProperty('overflow', 'auto', 'important')
            html.style.setProperty('overflow', 'auto', 'important')
            // 某些知乎版本可能还在 body 上设置了 position: fixed 或 top
            if (bodyStyle.position === 'fixed') {
              body.style.setProperty('position', 'static', 'important')
            }
            window.dispatchEvent(new Event('resize'))
          }
        }

        // 立即尝试一次，并在短时间后再确认一次（应对知乎脚本的异步操作）
        restore()
        setTimeout(restore, 500)
      }
    }
  }

  // 1. 使用 MutationObserver 监控 DOM 变化
  const observer = new MutationObserver(checkAndRestoreScroll)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
    childList: true,
    subtree: true, // 扩大到子树，确保能捕捉到深层的 Modal 移除
  })

  // 2. 补充：点击页面时也触发检查（关闭按钮通常在点击时生效）
  window.addEventListener(
    'click',
    () => {
      setTimeout(checkAndRestoreScroll, 100)
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
    }
  })
  checkIsFullScreen()
  fixScrollIssue()
}

main()
