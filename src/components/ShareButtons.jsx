import React, { useState } from 'react'

export default function ShareButtons({ url }){
  const [copied, setCopied] = useState(false)

  // SMS intent (works on mobile; desktop behavior depends on OS defaults)
  const smsHref = `sms:?&body=${encodeURIComponent(url)}`
  // Email fallback
  const mailHref = `mailto:?subject=Bike%20route&body=${encodeURIComponent(url)}`

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback for older browsers
      const ta = document.createElement('textarea')
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { return }
      document.body.removeChild(ta)
    }
  }

  return (
    <div className="share-buttons">
      <a className="btn" href={smsHref}>Send via SMS</a>
      <a className="btn" href={mailHref}>Send via Email</a>
      <button className="btn" onClick={handleCopy}>{copied ? 'Copied!' : 'Copy link'}</button>
    </div>
  )
}
