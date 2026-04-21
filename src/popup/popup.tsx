import { useState, useEffect, useMemo } from 'react'
import cls from 'classnames'
import { IoMdSettings } from 'react-icons/io'
import { PiPaintBrushHouseholdFill } from 'react-icons/pi'
import { BsBrightnessHighFill } from 'react-icons/bs'
import { TbContrast2Filled } from 'react-icons/tb'
import { FaCameraRetro } from 'react-icons/fa'
import { PiCheckerboardFill } from 'react-icons/pi'
import { RiAlarmWarningFill } from 'react-icons/ri'
import { useTranslation } from 'react-i18next'

import styles from './popup.module.scss'

import Button from '@/components/Button'
import Slider from '@/components/Slider'
import Switch from '@/components/SwitchMain'
import Setting from './Setting'
import { DEFAULT_CONFIG } from '@/constant'

import { matchWildcardUrls } from '@/utils'

interface Config {
  brightness: number
  contrast: number
  grayscale: number
  sepia: number
}

let globalState = {
  isDark: false,
  isGlobal: false,
  config: {},
}

const Popup = () => {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG)
  const [isDark, setIsDark] = useState<boolean>(false)
  const [isProtected, setIsProtected] = useState<boolean>(false)
  const [isExclude, setIsExclude] = useState<boolean>(false)
  const [inSettingPage, setInSettingPage] = useState<boolean>(false)

  const { i18n, t } = useTranslation()

  useEffect(() => {
    initCheck()
    chrome.runtime.onMessage.addListener(handleMessage)
    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage)
    }
  }, [])

  const initCheck = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const url = tabs[0].url
      if (url) {
        setIsProtected(isGoogleKeyManagementPage(url))
      }
    })

    function isGoogleKeyManagementPage(url: string) {
      return (
        url.includes('chrome://') ||
        url.includes('chromewebstore.google.com') ||
        url.includes('chrome.google.com/webstore/devconsole')
      )
    }
  }

  const handleMessage = (message: { action: string }) => {
    if (message.action === 'updatePopupConfig') {
      updatePopupConfig()
    }
  }

  useEffect(() => {
    updatePopupConfig()
  }, [inSettingPage])

  const updatePopupConfig = () => {
    chrome.runtime.sendMessage({ action: 'getGlobal' }, (response) => {
      if (response) {
        globalState = response.state
        const { isGlobal, isDark, config: _config } = globalState
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          const [{ url }] = tabs
          if (url) {
            // Maybe you will get an error
            if (matchWildcardUrls(url) && isGlobal) {
              setIsExclude(true)
            } else {
              setIsExclude(false)
            }
          }
        })
        if (isGlobal) {
          setIsDark(isDark)
          changeModeHandle(isDark)
          setConfig({
            ...config,
            ..._config,
          })
        } else {
          // 非全局，仅更新状态
          chrome.tabs.query(
            {
              active: true,
              currentWindow: true,
            },
            (tabs) => {
              let message = {
                info: 'getMode',
              }
              const [{ id }] = tabs
              if (id) {
                chrome.tabs.sendMessage(id, message, (res) => {
                  setIsDark(!!res?.has)
                  setConfig({
                    ...config,
                    ...res?.data,
                  })
                })
              }
            },
          )
        }
      }
    })
  }

  const onNotice = (config: Config) => {
    if (globalState.isGlobal) {
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
          if (tab.id) {
            let message = {
              info: 'changeConfig',
              data: config,
            }
            chrome.tabs.sendMessage(tab.id, message, () => {})
          }
        })
      })
    } else {
      chrome.tabs.query(
        {
          active: true,
          currentWindow: true,
        },
        (tabs) => {
          const [{ id }] = tabs
          if (id) {
            let message = {
              info: 'changeConfig',
              data: config,
            }
            chrome.tabs.sendMessage(id, message, () => {})
          }
        },
      )
    }
  }

  const gotoSetting = () => {
    setInSettingPage(true)
  }

  const switchOnChange = (v: boolean) => {
    changeModeHandle(v)
  }

  const changeModeHandle = (v: boolean) => {
    setIsDark(v)

    //  先更新后台状态，然后再通知标签页，避免获取到旧状态
    chrome.runtime.sendMessage(
      {
        action: 'setGlobal',
        state: {
          isDark: v,
        },
      },
      () => {
        if (globalState.isGlobal) {
          chrome.tabs.query({}, (tabs) => {
            for (let i = 0, len = tabs.length; i < len; i++) {
              const tab = tabs[i]
              const { url } = tab
              if (url) {
                if (matchWildcardUrls(url)) {
                  continue
                }
              }
              if (tab.id) {
                let message = {
                  info: 'changeMode',
                  data: { isDark: v }, //  传递最新状态
                }
                chrome.tabs.sendMessage(tab.id, message, (res) => {})
              }
            }
          })
        } else {
          chrome.tabs.query(
            {
              active: true,
              currentWindow: true,
            },
            (tabs) => {
              const [{ id }] = tabs
              if (id) {
                let message = {
                  info: 'changeMode',
                  data: { isDark: v }, //  传递最新状态
                }
                chrome.tabs.sendMessage(id, message, (res) => {})
              }
            },
          )
        }
      },
    )
  }

  const brightnessOnChange = (value: number) => {
    const t = {
      ...config,
      brightness: value,
    }
    setConfig(t)
    onNotice(t)
  }

  const contrastOnChange = (value: number) => {
    const t = {
      ...config,
      contrast: value,
    }
    setConfig(t)
    onNotice(t)
  }

  const grayscaleOnChange = (value: number) => {
    const t = {
      ...config,
      grayscale: value,
    }

    setConfig(t)
    onNotice(t)
  }

  const sepiaOnChange = (value: number) => {
    let t = {
      ...config,
      sepia: value,
    }
    setConfig(t)
    onNotice(t)
  }

  const resetAll = () => {
    setConfig(DEFAULT_CONFIG)
    onNotice(DEFAULT_CONFIG)
  }

  const onBack = () => {
    setInSettingPage(false)
  }

  const isCn = useMemo(() => {
    return i18n.language === 'zh'
  }, [i18n.language])

  return (
    <main className={cls(styles.main, inSettingPage ? styles.inSetting : '')}>
      <div className={styles.wrapper}>
        <div className={styles.header}>
          <Button className={styles.resetButton} onClick={resetAll}>
            <div className={styles.content}>
              <PiPaintBrushHouseholdFill size={20} />
            </div>
          </Button>
          <Button className={styles.settingButton} onClick={gotoSetting}>
            <IoMdSettings size={20} />
          </Button>
        </div>
        <div className={styles.switchWrap}>
          <Switch value={isDark} onChange={switchOnChange} />
        </div>
        <div className={styles.config}>
          <div className={styles.item}>
            <div className={styles.titleWrap}>
              <div className={styles.iconWrap}>
                <BsBrightnessHighFill size={20} className={styles.icon} />
              </div>
              <span className={isCn ? styles.zhLabel : ''}>{t('brightness')}</span>
            </div>
            <Slider
              className={styles.slider}
              onChange={(value) => {
                brightnessOnChange(value)
              }}
              value={config.brightness}
              max={20}
              min={0}
            />
          </div>
          <div className={styles.item}>
            <div className={styles.titleWrap}>
              <div className={styles.iconWrap}>
                <TbContrast2Filled size={22} className={styles.icon} />
              </div>
              <span className={isCn ? styles.zhLabel : ''}>{t('contrast')}</span>
            </div>
            <Slider
              className={styles.slider}
              onChange={(value) => {
                contrastOnChange(value)
              }}
              value={config.contrast}
              max={15}
              min={0}
            />
          </div>
          <div className={styles.item}>
            <div className={styles.titleWrap}>
              <div className={styles.iconWrap}>
                <PiCheckerboardFill size={24} className={styles.icon} />
              </div>
              <span className={isCn ? styles.zhLabel : ''}>{t('grayscale')}</span>
            </div>
            <Slider
              className={styles.slider}
              onChange={(value) => {
                grayscaleOnChange(value)
              }}
              value={config.grayscale}
              max={10}
              min={0}
            />
          </div>
          <div className={styles.item}>
            <div className={styles.titleWrap}>
              <div className={styles.iconWrap}>
                <FaCameraRetro size={20} className={styles.icon} />
              </div>
              <span className={isCn ? styles.zhLabel : ''}>{t('sepia')}</span>
            </div>
            <Slider
              className={styles.slider}
              onChange={(value) => {
                sepiaOnChange(value)
              }}
              value={config.sepia}
              max={10}
              min={0}
            />
          </div>
          {isProtected ? (
            <p className={cls(styles.tips, isProtected ? styles.visible : '')}>
              <RiAlarmWarningFill size={12} className={styles.tipsIcon} />
              <span>{t('protectedTips')}</span>
            </p>
          ) : (
            <p className={cls(styles.tips, isExclude ? styles.visible : '')}>
              <RiAlarmWarningFill size={12} className={styles.tipsIcon} />
              <span>{t('excludeTips')}</span>
            </p>
          )}
        </div>
      </div>
      <Setting onBack={onBack} />
    </main>
  )
}

export default Popup
