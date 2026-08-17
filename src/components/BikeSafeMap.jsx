import React, { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import QRCode from 'qrcode'
import ShareButtons from './ShareButtons.jsx'
import GeoAutocomplete from './GeoAutocomplete.jsx'
import RouteInsights from './RouteInsights.jsx'
import {
  haversineMeters, toRiskFCRaw, routeSig,
  riskScore as riskScoreRaw, scenicScore as scenicScoreRaw,
  getInsights, distanceOf, isSameRoute, routeOverlap,
  byDistinctness, cloneAndLabel, wayLabel, INFRA_LABEL,
} from '../utils/scoring.js'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const ORS_KEY      = import.meta.env.VITE_ORS_KEY
const ORS_BASE     = import.meta.env.DEV ? '/ors' : 'https://api.openrouteservice.org'

const DEFAULT_CENTER = [-79.6440, 43.5890]
const DEFAULT_ZOOM   = 12
const SAFETY_DISTANCE_WEIGHT = 0.12
const SCENIC_SCORE_WEIGHT = 0.58
const SCENIC_DISTANCE_WEIGHT = 0.27
const SCENIC_SAFETY_WEIGHT = 0.15
const SCENIC_MIN_DETOUR = 1.12
const SCENIC_TARGET_DETOUR = 1.32
const SCENIC_MAX_DETOUR = 1.75

const http = async (url, opts = {}, timeout = 20000) => {
  const ctl = new AbortController()
  const id = setTimeout(()=>ctl.abort(), timeout)
  try { return await fetch(url, { ...opts, signal: ctl.signal }) }
  finally { clearTimeout(id) }
}

// Prefer user's location for initial map center; fall back to Mississauga if unavailable/denied.
async function getInitialCenter(){
  if (!('geolocation' in navigator)) return DEFAULT_CENTER
  try{
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        resolve,
        reject,
        { enableHighAccuracy:false, timeout:7000, maximumAge:300000 }
      )
    })
    const { longitude: lng, latitude: lat } = pos.coords || {}
    return (Number.isFinite(lng) && Number.isFinite(lat)) ? [lng, lat] : DEFAULT_CENTER
  }catch{
    return DEFAULT_CENTER
  }
}

export default function BikeSafeMap(){
  const mapRef = useRef(null)
  const panelRef = useRef(null)
  const qrRef = useRef(null)
  const popupRef = useRef(null)

  const hoveredRidRef = useRef(-1)
  const routeCoordsRef = useRef([])
  const distKmRef = useRef([])
  const lastRouteRef = useRef(null)

  const originMarkerRef = useRef(null)
  const destMarkerRef = useRef(null)
  const routeDebounceRef = useRef(null)

  const [map, setMap] = useState(null)
  const [originText, setOriginText] = useState('')
  const [destText, setDestText] = useState('')
  const [originCoord, setOriginCoord] = useState(null)
  const [destCoord, setDestCoord] = useState(null)
  const [activePicker, setActivePicker] = useState(null)

  const [shareUrl, setShareUrl] = useState('')
  const [insights, setInsights] = useState(null)
  const [riskMix, setRiskMix] = useState(null)
  const [riskBands, setRiskBands] = useState([])
  const [directions, setDirections] = useState([])

  const [routing, setRouting] = useState(false)
  const [err, setErr] = useState(null)
  const [poolWarning, setPoolWarning] = useState(null)
  const [mapReady, setMapReady] = useState(false)

  const [showCyclePaths, setShowCyclePaths] = useState(false)
  const CYCLE_LAYER_ID = 'cycle-paths-overlay'
  const CYCLE_CASING_ID = 'cycle-paths-overlay-casing'

  const [biasProximity, setBiasProximity] = useState([DEFAULT_CENTER[0], DEFAULT_CENTER[1]])
  const [biasBBox, setBiasBBox] = useState(null)
  const [acResetKey, setAcResetKey] = useState(0)

  const [routes, setRoutes] = useState([])   // exactly 3 designated routes
  const [routeInsightsCache, setRouteInsightsCache] = useState([]) // cached getInsights per route
  const [activeRouteIdx, setActiveRouteIdx] = useState(0)
  const riskFCCache = useRef(new Map())  // cache toRiskFC results keyed by routeSig

  // --- risk overlay housekeeping
  const safeRemoveLayer  = (m, id) => { try { if (m.getLayer(id))  m.removeLayer(id) } catch { return } }
  const safeRemoveSource = (m, id) => { try { if (m.getSource(id)) m.removeSource(id) } catch { return } }
  const clearRiskOverlay = (m) => {
    safeRemoveLayer(m, 'route-risk-hover')
    safeRemoveLayer(m, 'route-risk-line')
    safeRemoveSource(m, 'route-risk')
  }

  // map init (geolocate if allowed; else Mississauga)
  useEffect(() => {
    if(!MAPTILER_KEY)
      { setErr('Missing MapTiler key. Set VITE_MAPTILER_KEY.'); return }
    let m
    let cancelled = false;

    (async () => {
      const center = await getInitialCenter()
      if (cancelled) return
      try{
        m = new maplibregl.Map({
          container: mapRef.current,
          style: `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`,
          center,
          zoom: DEFAULT_ZOOM
        })
        m.addControl(new maplibregl.NavigationControl({ showCompass:false }))
        m.once('load', () => {
          setMap(m)
          setMapReady(true)
          popupRef.current = new maplibregl.Popup({ closeButton:false, closeOnClick:false, offset:8, maxWidth:'280px' })
          ensureParksOverlay(m)
        })
        m.on('error', (e) => setErr(e?.error?.message || 'Map error — check MapTiler key.'))
      }catch{ setErr('Failed to init map. Check keys/network.') }
    })()
    return () => { cancelled = true; try{ m && m.remove() }catch{ return } }
  }, [])

  // bias search to viewport
  useEffect(() => {
    if (!map) return
    const update = () => {
      const c = map.getCenter(), b = map.getBounds()
      setBiasProximity([+c.lng.toFixed(5), +c.lat.toFixed(5)])
      setBiasBBox([+b.getWest().toFixed(5), +b.getSouth().toFixed(5), +b.getEast().toFixed(5), +b.getNorth().toFixed(5)])
    }
    update()
    map.on('moveend', update)
    return () => map.off('moveend', update)
  }, [map])

  // resize
  useEffect(() => {
    if(!map) return
    const onResize = () => map.resize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [map])

  // click-to-pick pins
  useEffect(() => {
    if(!map) return
    map.getCanvas().style.cursor = activePicker ? 'crosshair' : ''
    const onClick = (e) => {
      if (!activePicker) return
      const c = { lng: e.lngLat.lng, lat: e.lngLat.lat }

      if (activePicker === 'origin') {
        setOriginCoord(c)
        setOriginText(`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`)
        addOrMoveMarker('origin', c)
        const d = destMarkerRef.current?.getLngLat?.()
        if (d) route({ origin: c, dest: { lng: d.lng, lat: d.lat } })
      } else {
        setDestCoord(c)
        setDestText(`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`)
        addOrMoveMarker('dest', c)
        const o = originMarkerRef.current?.getLngLat?.()
        if (o) route({ origin: { lng: o.lng, lat: o.lat }, dest: c })
      }
      setActivePicker(null)
    }
    const onEsc = (ev) => { if(ev.key === 'Escape') setActivePicker(null) }
    map.on('click', onClick)
    window.addEventListener('keydown', onEsc)
    return () => { map.off('click', onClick); window.removeEventListener('keydown', onEsc); map.getCanvas().style.cursor = '' }
  }, [map, activePicker])

  // drag-drop onto map
  useEffect(() => {
    if (!map || !mapRef.current) return
    const el = mapRef.current
    const onDragOver = (e) => { if (e.dataTransfer?.types?.includes('text/pin') || e.dataTransfer?.types?.includes('text/plain')) e.preventDefault() }
    const onDrop = (e) => {
      e.preventDefault()
      const which = (e.dataTransfer.getData('text/pin') || e.dataTransfer.getData('text/plain') || '').toLowerCase()
      const kind = (which === 'origin' || which === 'start' || which === 'from') ? 'origin' : 'dest'
      const rect = el.getBoundingClientRect()
      const pt = [e.clientX - rect.left, e.clientY - rect.top]
      placeByDrop(kind, map.unproject(pt))
    }
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    return () => { el.removeEventListener('dragover', onDragOver); el.removeEventListener('drop', onDrop) }
  }, [map, originCoord, destCoord])

  // --- Draw designated routes, rebuild risk overlay when selection changes
  useEffect(() => {
    if (!map || !routes?.length || !map.isStyleLoaded?.()) return

    try {
      // draw 3 designated routes; dim those not active
      routes.forEach((feat, idx) => {
        const src = `route-${idx}`
        const id  = `route-line-${idx}`
        const isActive = idx === activeRouteIdx

        if (!map.getSource(src)) map.addSource(src, { type: 'geojson', data: feat })
        else map.getSource(src).setData(feat)

        if (!map.getLayer(id)) {
          map.addLayer({
            id,
            type: 'line',
            source: src,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-width': isActive ? 8 : 5,          // thicker
              'line-color': isActive ? '#60a5fa' : '#9ca3af',
              'line-opacity': isActive ? 1.0 : 0.35
            }
          })
          map.on('click', id, () => setActiveRouteIdx(idx))
        } else {
          map.setPaintProperty(id, 'line-width',  isActive ? 8 : 5)
          map.setPaintProperty(id, 'line-color',  isActive ? '#60a5fa' : '#9ca3af')
          map.setPaintProperty(id, 'line-opacity',isActive ? 1.0 : 0.35)
        }
      })

      // rebuild risk overlay for the ACTIVE route
      const active = routes[activeRouteIdx]
      clearRiskOverlay(map)

      const riskFC = toRiskFC(active)
      if (riskFC?.features?.length) {
        map.addSource('route-risk', { type:'geojson', data:riskFC })

        map.addLayer({
          id:'route-risk-line', type:'line', source:'route-risk',
          layout:{ 'line-cap':'round','line-join':'round' },
          paint:{
            'line-width':10,  // thicker risk
            'line-color':['match',['get','risk'],
              'high','#ef4444','med','#f59e0b','low','#10b981','#10b981']
          }
        })

        map.addLayer({
          id:'route-risk-hover', type:'line', source:'route-risk',
          paint:{ 'line-width':14, 'line-color':'#ffffff', 'line-opacity':0.25 },
          filter:['==',['get','rid'],-1]
        })
        hoveredRidRef.current = -1
      }

      // update insights + directions + cursor + panel metrics
      if (active) {
        lastRouteRef.current = active
        routeCoordsRef.current = active.geometry?.coordinates || []

        const i = getInsights(active)
        setInsights(i)
        distKmRef.current = i?.distKm || []
        setDirections(flatSteps(active))

        // compute risk mix + bands against current distKm
        if (riskFC?.features?.length) {
          const kmByRisk = { low:0, med:0, high:0 }
          for (const f of riskFC.features) {
            const c = f.geometry?.coordinates || []
            let len = 0
            for (let k=1;k<c.length;k++){
              const [x1,y1] = c[k-1], [x2,y2] = c[k]
              len += haversineMeters({lng:x1,lat:y1},{lng:x2,lat:y2})
            }
            const r = f.properties?.risk
            if (kmByRisk[r] != null) kmByRisk[r] += (len/1000)
          }
          const totalKm = kmByRisk.low + kmByRisk.med + kmByRisk.high || 1
          setRiskMix({
            ...kmByRisk, totalKm,
            pctLow:Math.round((kmByRisk.low/totalKm)*100),
            pctMed:Math.round((kmByRisk.med/totalKm)*100),
            pctHigh:Math.round((kmByRisk.high/totalKm)*100),
          })

          const bands = []
          const distKm = distKmRef.current
          for (const f of riskFC.features){
            const s = f.properties?.sIndex ?? 0
            const e = f.properties?.eIndex ?? s
            const fromKm = distKm[Math.max(0, Math.min(distKm.length-1, s))] ?? 0
            const toKm   = distKm[Math.max(0, Math.min(distKm.length-1, e))] ?? fromKm
            const risk   = f.properties?.risk || 'low'
            const way    = f.properties?.way
            const infra  = f.properties?.infraType
            const label  = (infra && INFRA_LABEL[infra]) ? INFRA_LABEL[infra] : wayLabel(way)
            const reasons = String(f.properties?.why || '')
              .split(' • ').map(s => s.trim()).filter(Boolean)
            bands.push({ fromKm, toKm, risk, wayLabel: label, reasons })
          }
          setRiskBands(bands)
        }

        fitRoute(active, { tightness: 1.6 })
        ensureRouteCursor()
        if (routeCoordsRef.current.length) {
          const [lng, lat] = routeCoordsRef.current[0]
          updateRouteCursor(lng, lat)
        }
      }
    } catch (err) {
      console.error('Map route draw error:', err)
    }
  }, [map, routes, activeRouteIdx])

// re-add parks overlay if style reloads (like we do for cycle paths)
useEffect(() => {
  if (!map) return
  const tryParks = () => ensureParksOverlay(map)
  map.on('styledata', tryParks)
  return () => map.off('styledata', tryParks)
}, [map])


  // hover popup for risk segments
  useEffect(() => {
    if(!map) return
    const onMove = (e) => {
      if (!map.getLayer('route-risk-line')) { map.getCanvas().style.cursor=''; popupRef.current?.remove(); return }
      let feats = []
      try { feats = map.queryRenderedFeatures(e.point, { layers: ['route-risk-line'] }) } catch { return }
      if (!feats.length){ map.getCanvas().style.cursor=''; popupRef.current?.remove(); if (map.getLayer('route-risk-hover')) map.setFilter('route-risk-hover', ['==',['get','rid'],-1]); hoveredRidRef.current=-1; return }

      map.getCanvas().style.cursor='pointer'
      const f = feats[0]
      const { risk='low', why='', rid=-1, way, infraType } = f.properties || {}

      if (map.getLayer('route-risk-hover') && Number(rid) !== hoveredRidRef.current) {
        map.setFilter('route-risk-hover', ['==', ['get','rid'], Number(rid)])
        hoveredRidRef.current = Number(rid)
      }

      const color = risk==='high' ? '#991b1b' : risk==='med' ? '#92400e' : '#065f46'
      const roadLabel = (infraType && INFRA_LABEL[infraType]) ? INFRA_LABEL[infraType] : wayLabel(way)
      const lines = [`Road: ${roadLabel}`, ...(String(why).split(' • ').filter(Boolean))]

      popupRef.current
        .setLngLat(e.lngLat)
        .setHTML(`
          <div style="font:12px system-ui; line-height:1.4; max-width:260px; color:#0b1220;">
            <div style="font-weight:700; margin-bottom:6px; text-transform:uppercase; letter-spacing:.02em; color:${color}">
              ${String(risk).toUpperCase()} RISK
            </div>
            ${lines.map(s=>`<div style="margin:2px 0;">• <span style="color:#111827">${s}</span></div>`).join('')}
          </div>
        `)
        .addTo(map)
    }
    map.on('mousemove', onMove)
    return () => { map.off('mousemove', onMove); popupRef.current?.remove() }
  }, [map])

  // geolocation
  const applyMyLocation = (which) => {
    if (!navigator.geolocation) { setErr('Geolocation not supported'); return }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = { lng: pos.coords.longitude, lat: pos.coords.latitude }
        if(which === 'origin'){
          setOriginCoord(c); setOriginText(`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`); addOrMoveMarker('origin', c)
        }else{
          setDestCoord(c); setDestText(`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`); addOrMoveMarker('dest', c)
        }
        map?.easeTo({ center:[c.lng,c.lat], zoom:13 })
      },
      (e) => setErr(e?.message || 'Location error'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    )
  }

  function resolveTransportSource(m){
    const layers = m.getStyle()?.layers || []
    for (const L of layers){
      if (L['source-layer'] === 'transportation' && m.getSource(L.source)) {
        return { source: L.source, sourceLayer: 'transportation' }
      }
    }
    for (const name of ['openmaptiles','composite','basemap','maptiler']){
      if (m.getSource(name)) return { source: name, sourceLayer: 'transportation' }
    }
    return null
  }

  function firstBeforeId(m){
    for (const id of ['route-risk-hover','route-risk-line','route-line']) {
      if (m.getLayer(id)) return id
    }
    const layers = m.getStyle()?.layers || []
    const label = [...layers].reverse().find(L => (L.type === 'symbol'))
    return label?.id || undefined
  }

  function addCyclePathsLayer(){
    const m = map
    if (!m || m.getLayer(CYCLE_LAYER_ID)) return

    const found = resolveTransportSource(m)
    if (!found){
      console.warn('[cycle-overlay] transport source not ready; will retry on next styledata')
      return
    }

    const before = firstBeforeId(m)

    const baseFilter = [
      'any',
      ['==', ['get','class'], 'cycleway'],
      ['==', ['get','subclass'], 'cycleway'],
      ['all',
        ['==', ['get','class'], 'path'],
        ['in', ['coalesce', ['get','bicycle'], 'no'], ['literal', ['designated','yes']]]
      ]
    ]

    m.addLayer({
      id: CYCLE_CASING_ID,
      type: 'line',
      source: found.source,
      'source-layer': found.sourceLayer,
      filter: baseFilter,
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 16, 6],
        'line-opacity': 0.35
      }
    }, before)

    m.addLayer({
      id: CYCLE_LAYER_ID,
      type: 'line',
      source: found.source,
      'source-layer': found.sourceLayer,
      filter: baseFilter,
      paint: {
        'line-color': '#22c55e',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 14, 3, 16, 5],
        'line-opacity': 0.9
      }
    }, before)
  }

  function removeCyclePathsLayer(){
    if (!map) return
    try { if (map.getLayer(CYCLE_LAYER_ID))  map.removeLayer(CYCLE_LAYER_ID) } catch { return }
    try { if (map.getLayer(CYCLE_CASING_ID)) map.removeLayer(CYCLE_CASING_ID) } catch { return }
  }

  // toggle overlay
  useEffect(() => {
    if (!map) return
    showCyclePaths ? addCyclePathsLayer() : removeCyclePathsLayer()
  }, [map, showCyclePaths])

  // re-add overlay if style reloads
  useEffect(() => {
    if (!map) return
    const tryAdd = () => { if (showCyclePaths && !map.getLayer(CYCLE_LAYER_ID)) addCyclePathsLayer() }
    map.on('styledata', tryAdd)
    return () => map.off('styledata', tryAdd)
  }, [map, showCyclePaths])

  // pins
  const HEX_RE = /^#[0-9a-fA-F]{3,8}$/
  const makePinEl = (hex) => {
    const safe = HEX_RE.test(hex) ? hex : '#888'
    const el = document.createElement('div')
    el.style.width='26px'; el.style.height='32px'; el.style.pointerEvents='auto'; el.style.background='transparent'
    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 32')
    svg.setAttribute('width', '26')
    svg.setAttribute('height', '32')
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', 'M12 1C7.03 1 3 5.03 3 10c0 6.6 9 20 9 20s9-13.4 9-20C21 5.03 16.97 1 12 1z')
    path.setAttribute('fill', safe)
    const circle = document.createElementNS(NS, 'circle')
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '10'); circle.setAttribute('r', '3.2')
    circle.setAttribute('fill', '#fff'); circle.setAttribute('fill-opacity', '0.35')
    svg.appendChild(path); svg.appendChild(circle)
    el.appendChild(svg)
    return el
  }
  const recolorMarker = (ref, hex) => {
    const el = ref?.current?.getElement?.()
    const path = el?.querySelector('path')
    if (path && path.getAttribute('fill') !== hex) path.setAttribute('fill', hex)
  }
  const addOrMoveMarker = (id, c) => {
    if (!map) return
    const ref = id === 'origin' ? originMarkerRef : destMarkerRef
    const color = id === 'origin' ? '#22c55e' : '#ef4444'
    if (ref.current){ ref.current.setLngLat([c.lng, c.lat]); recolorMarker(ref, color); return }
    const marker = new maplibregl.Marker({ element: makePinEl(color), draggable:true, anchor:'bottom' })
      .setLngLat([c.lng,c.lat]).addTo(map)
    const wrap = marker.getElement(); Object.assign(wrap.style, { background:'transparent', border:0, boxShadow:'none', padding:0, borderRadius:0 })
    marker.on('dragend', () => {
      const { lng, lat } = marker.getLngLat()
      const p = { lng, lat }
      if (id === 'origin') {
        setOriginCoord(p)
        setOriginText(`${lat.toFixed(5)},${lng.toFixed(5)}`)
        const d = destMarkerRef.current?.getLngLat?.()
        if (d) {
          clearTimeout(routeDebounceRef.current)
          routeDebounceRef.current = setTimeout(() => route({ origin: p, dest: { lng: d.lng, lat: d.lat } }), 400)
        }
      } else {
        setDestCoord(p)
        setDestText(`${lat.toFixed(5)},${lng.toFixed(5)}`)
        const o = originMarkerRef.current?.getLngLat?.()
        if (o) {
          clearTimeout(routeDebounceRef.current)
          routeDebounceRef.current = setTimeout(() => route({ origin: { lng: o.lng, lat: o.lat }, dest: p }), 400)
        }
      }
    })
    if (id === 'origin') originMarkerRef.current = marker
    else destMarkerRef.current = marker
  }
  const setPinDragImage = (ev, color) => {
    const ghost = makePinEl(color)
    ghost.style.position='fixed'; ghost.style.left='-9999px'; ghost.style.top='-9999px'
    document.body.appendChild(ghost)
    ev.dataTransfer.setDragImage(ghost, 13, 30)
    setTimeout(()=>document.body.removeChild(ghost),0)
  }
  const onDragStartPin = (ev, which) => {
    const kind = String(which).toLowerCase()==='origin' ? 'origin' : 'dest'
    ev.dataTransfer.setData('text/pin', kind)
    ev.dataTransfer.setData('text/plain', kind)
    ev.dataTransfer.effectAllowed = 'copyMove'
    setPinDragImage(ev, kind==='origin' ? '#22c55e' : '#ef4444')
  }
  const placeByDrop = (which, lngLat) => {
    const c = { lng: lngLat.lng, lat: lngLat.lat }
    if (which === 'origin') {
      setOriginCoord(c)
      setOriginText(`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`)
      addOrMoveMarker('origin', c)
      const d = destMarkerRef.current?.getLngLat?.()
      if (d) route({ origin: c, dest: { lng: d.lng, lat: d.lat } })
    } else {
      setDestCoord(c)
      setDestText(`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`)
      addOrMoveMarker('dest', c)
      const o = originMarkerRef.current?.getLngLat?.()
      if (o) route({ origin: { lng: o.lng, lat: o.lat }, dest: c })
    }
  }

  // geocode or lat,lng
  const parseLatLng = (t) => {
    const m = String(t||'').trim().match(/^([+-]?\d+(?:\.\d+)?)[,\s]+([+-]?\d+(?:\.\d+)?)$/)
    if (!m) return null
    const lat = +m[1], lng = +m[2]
    if (!Number.isFinite(lat)||!Number.isFinite(lng)) return null
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    return { lat, lng }
  }
  const geocode = async (q) => {
    const ll = parseLatLng(q); if (ll) return { lng: ll.lng, lat: ll.lat }
    if (!MAPTILER_KEY) throw new Error('To search by address, set VITE_MAPTILER_KEY')
    const params = new URLSearchParams({ key: MAPTILER_KEY, limit: '1' })
    if (biasProximity?.length===2) params.set('proximity', `${biasProximity[0]},${biasProximity[1]}`)
    if (biasBBox?.length===4) params.set('bbox', biasBBox.join(','))
    const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(String(q))}.json?${params}`
    const res = await http(url, { headers:{ accept:'application/json' } }, 12000)
    if (!res.ok) throw new Error(`Place search failed (${res.status})`)
    const data = await res.json()
    const feat = data?.features?.[0]; if (!feat?.center) throw new Error('Place not found')
    const [lng, lat] = feat.center; return { lng, lat }
  }

  // --- risk + insights (pure helpers imported from scoring.js) ---
  const toRiskFC = (feature) => {
    if (!feature) return null
    const key = routeSig(feature)
    const cached = riskFCCache.current.get(key)
    if (cached) return cached
    const result = toRiskFCRaw(feature)
    if (result) riskFCCache.current.set(key, result)
    return result
  }
  // riskScore / scenicScore wrappers that use the cached toRiskFC
  const riskScore = (feature, routeType) => riskScoreRaw(feature, toRiskFC, routeType)
  const scenicScore = (feature) => scenicScoreRaw(feature, toRiskFC, (coords) => envBonusNear(map, coords, 28))


// --- Robust ORS request with profile + fallbacks for common 400s
const orsPost = async (body, profile = 'cycling-regular') => {
  const apiKey = ORS_KEY || import.meta.env.VITE_ORS_KEY
  if (!apiKey) throw new Error('Missing OpenRouteService key (VITE_ORS_KEY)')
  const baseURL = `${ORS_BASE}/v2/directions/${profile}/geojson`
  const headers = {
    'Authorization': apiKey,
    'content-type':'application/json',
    'accept':'application/geo+json, application/json;q=0.9, */*;q=0.8'
  }

  const doFetch = async (b) => {
    const res = await http(baseURL, { method:'POST', headers, body: JSON.stringify(b) }, 20000)
    const text = await res.text()
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    const json = ct.includes('json') ? JSON.parse(text) : null
    return { res, text, json }
  }

  let cur = body
  for (let attempt = 0; attempt < 6; attempt++){
    const { res, text, json } = await doFetch(cur)
    if (res.ok) return json
    const msg = (json?.error?.message || json?.message || text || '').toString()

    // fallbacks — strip unsupported extras one at a time
    if (res.status === 400 && /extra_info|waycategory/i.test(msg) && Array.isArray(cur.extra_info) && cur.extra_info.includes('waycategory')) {
      cur = { ...cur, extra_info: cur.extra_info.filter(x => x !== 'waycategory') }
      continue
    }
    if (res.status === 400 && /extra_info|avgspeed/i.test(msg) && Array.isArray(cur.extra_info) && cur.extra_info.includes('avgspeed')) {
      cur = { ...cur, extra_info: cur.extra_info.filter(x => x !== 'avgspeed') }
      continue
    }
    if (res.status === 400 && /extra_info|suitability/i.test(msg) && Array.isArray(cur.extra_info) && cur.extra_info.includes('suitability')) {
      cur = { ...cur, extra_info: cur.extra_info.filter(x => x !== 'suitability') }
      continue
    }
    if (res.status === 400 && /avoid_features/i.test(msg) && cur?.options?.avoid_features) {
      const options = { ...(cur.options || {}) }; delete options.avoid_features
      cur = { ...cur, options }
      continue
    }
    if (res.status === 400 && /profile_params|weightings|options/i.test(msg) && cur?.options?.profile_params) {
      const options = { ...(cur.options || {}) }; delete options.profile_params
      cur = { ...cur, options }
      continue
    }
    if (res.status === 400 && /alternative_routes/i.test(msg) && cur?.options?.alternative_routes) {
      const options = { ...(cur.options || {}) }; delete options.alternative_routes
      cur = { ...cur, options }
      continue
    }
    const safeMsg = res.status === 400 ? 'Bad routing request' : res.status === 403 ? 'API key invalid or expired' : res.status === 429 ? 'Rate limit exceeded — try again shortly' : `Routing service error (${res.status})`
    throw new Error(safeMsg)
  }
  throw new Error('ORS failed after retries')
}



// Returns up to N alternatives from ORS for a profile+preference
async function fetchORSWithAlts(o, d, {
  profile = 'cycling-regular',
  preference = 'recommended',
  altCount = 3,
  weightFactor = 1.6,
  steepnessDifficulty = 1,
  avoidFeatures,
  shareFactor = 0.6,
} = {}) {
  const body = {
    coordinates: [[o.lng,o.lat],[d.lng,d.lat]],
    preference,
    elevation: true,
    instructions: true,
    instructions_format: 'text',
    extra_info: ['steepness','surface','waytype','suitability','avgspeed','waycategory'],
    options: {
      profile_params: { weightings: { steepness_difficulty: steepnessDifficulty } },
      ...(avoidFeatures?.length ? { avoid_features: avoidFeatures } : {}),
      alternative_routes: altCount > 1 ? {
        target_count: altCount,
        share_factor: shareFactor,
        weight_factor: weightFactor
      } : undefined
    }
  }

  const json = await orsPost(body, profile)
  const feats = (json?.features || []).map(f => {
    f.properties = { ...(f.properties||{}), _preference: preference, _profile: profile }
    return f
  })
  return feats
}



// --- Scenic / environment helpers (map-dependent, so they stay here) ------

const waterLayerIds = (m) => {
  const layers = m?.getStyle()?.layers || []
  return layers
    .filter(L => /water/i.test(L.id) && (L.type === 'fill' || L.type === 'line'))
    .map(L => L.id)
}

const envBonusNear = (m, coords, pxRadius = 28) => {
  if (!m || !m.isStyleLoaded?.() || !coords?.length) return 0

  const parksLayerExists = !!m.getLayer('parks-fill')
  const wIds = waterLayerIds(m)
  const landuseLayerIds = (!parksLayerExists)
    ? (m.getStyle()?.layers || []).filter(L => L['source-layer'] === 'landuse').map(L => L.id)
    : []

  const queryAt = (coord) => {
    const pt = m.project([coord[0], coord[1]])
    if (!pt) return 0
    const bbox = [
      { x: pt.x - pxRadius, y: pt.y - pxRadius },
      { x: pt.x + pxRadius, y: pt.y + pxRadius }
    ]
    let b = 0
    const layersToQuery = []
    if (parksLayerExists) layersToQuery.push('parks-fill')
    if (wIds.length) layersToQuery.push(...wIds)

    if (layersToQuery.length) {
      const feats = m.queryRenderedFeatures(bbox, { layers: layersToQuery })
      if (parksLayerExists && feats.some(f => f.layer?.id === 'parks-fill')) b += 3.0
      if (wIds.length && feats.some(f => wIds.includes(f.layer?.id))) b += 2.0
      return b
    }

    if (landuseLayerIds.length) {
      const feats = m.queryRenderedFeatures(bbox, { layers: landuseLayerIds })
      const isParky = (p) =>
        ['park','recreation_ground','garden','nature_reserve','protected_area'].includes(p?.class) ||
        p?.subclass === 'park'
      if (feats.some(f => isParky(f.properties || {}))) b += 3.0
    }
    if (wIds.length) {
      const wfeats = m.queryRenderedFeatures(bbox, { layers: wIds })
      if (wfeats?.length) b += 2.0
    }
    return b
  }

  try {
    const maxSamples = 5
    const step = Math.max(1, Math.floor(coords.length / maxSamples))
    let total = 0, count = 0
    for (let i = 0; i < coords.length; i += step) {
      total += queryAt(coords[i])
      count++
    }
    return count > 0 ? total / count : 0
  } catch {
    return 0
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const normalizedValue = (value, min, max) => {
  if (!Number.isFinite(value)) return 0
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0.5
  return clamp((value - min) / (max - min), 0, 1)
}

const scoreDistanceFit = (detourFactor, targetFactor = SCENIC_TARGET_DETOUR, maxFactor = SCENIC_MAX_DETOUR) => {
  if (!Number.isFinite(detourFactor) || detourFactor < 1 || detourFactor > maxFactor) return 0
  if (detourFactor < SCENIC_MIN_DETOUR) {
    return clamp((detourFactor - 1) / Math.max(0.001, SCENIC_MIN_DETOUR - 1), 0, 1) * 0.7
  }
  const span = Math.max(0.001, maxFactor - SCENIC_MIN_DETOUR)
  const distanceFromTarget = Math.abs(detourFactor - targetFactor)
  return 1 - clamp(distanceFromTarget / span, 0, 1)
}

const compareByNumber = (...getters) => (left, right) => {
  for (const getter of getters) {
    const diff = getter(left) - getter(right)
    if (diff !== 0) return diff
  }
  return 0
}

const rankSafestCandidate = (candidates, shortestDist, scoreRisk) => {
  if (!candidates.length) return null
  const metrics = candidates.map((feature) => {
    const distance = distanceOf(feature)
    const detourFactor = shortestDist > 0 ? distance / shortestDist : 1
    const safety = scoreRisk(feature, 'safest')
    return {
      feature,
      distance,
      safety,
      weightedScore: safety + Math.max(0, detourFactor - 1) * SAFETY_DISTANCE_WEIGHT,
    }
  })

  return metrics.sort(compareByNumber(
    (item) => item.weightedScore,
    (item) => item.safety,
    (item) => item.distance,
  ))[0]?.feature ?? null
}

const rankScenicCandidate = (candidates, shortestDist, shortestRoute, safestRoute, scoreRisk, scoreScenic) => {
  if (!candidates.length) return null

  const metrics = candidates
    .map((feature) => {
      const distance = distanceOf(feature)
      const detourFactor = shortestDist > 0 ? distance / shortestDist : 1
      const scenic = scoreScenic(feature)
      const safety = scoreRisk(feature, 'scenic')
      const overlapPenalty = Math.max(
        routeOverlap(feature, shortestRoute),
        routeOverlap(feature, safestRoute),
      )

      return {
        feature,
        distance,
        detourFactor,
        scenic,
        safety,
        overlapPenalty,
        distanceFit: scoreDistanceFit(detourFactor),
      }
    })
    .filter((item) => item.scenic != null && item.detourFactor <= SCENIC_MAX_DETOUR)

  if (!metrics.length) return null

  const scenicValues = metrics.map((item) => item.scenic)
  const safetyValues = metrics.map((item) => item.safety)
  const scenicMin = Math.min(...scenicValues)
  const scenicMax = Math.max(...scenicValues)
  const safetyMin = Math.min(...safetyValues)
  const safetyMax = Math.max(...safetyValues)

  return metrics
    .map((item) => {
      const scenicNorm = normalizedValue(item.scenic, scenicMin, scenicMax)
      const safetyNorm = 1 - normalizedValue(item.safety, safetyMin, safetyMax)
      const overlapPenalty = clamp(item.overlapPenalty, 0, 1) * 0.2

      return {
        ...item,
        weightedScore:
          scenicNorm * SCENIC_SCORE_WEIGHT +
          item.distanceFit * SCENIC_DISTANCE_WEIGHT +
          safetyNorm * SCENIC_SAFETY_WEIGHT -
          overlapPenalty,
      }
    })
    .sort(compareByNumber(
      (item) => -item.weightedScore,
      (item) => item.overlapPenalty,
      (item) => item.safety,
      (item) => -item.distance,
    ))[0]?.feature ?? null
}



async function fetchThreeRoutes(o, d) {
  // A) Shortest — exact shortest path, with safety only as a strict tie-break
  const shortestList = await fetchORSWithAlts(o, d, { profile:'cycling-road', preference:'shortest', altCount:3 })
  if (!shortestList.length) throw new Error('No route (shortest)')
  const shortest = [...shortestList].sort(compareByNumber(
    (feature) => distanceOf(feature),
    (feature) => riskScore(feature, 'shortest'),
  ))[0]
  const shortestDist = distanceOf(shortest)

  // B) Pools for weighted re-ranking
  let poolWarning = null
  const results = await Promise.allSettled([
    fetchORSWithAlts(o, d, { profile:'cycling-road',    preference:'recommended', altCount:8, weightFactor:3.0, shareFactor:0.4 }),
    fetchORSWithAlts(o, d, { profile:'cycling-road',    preference:'recommended', altCount:6, weightFactor:2.2, shareFactor:0.4 }),
    fetchORSWithAlts(o, d, { profile:'cycling-regular', preference:'recommended', altCount:6, weightFactor:1.8,
      steepnessDifficulty:2, avoidFeatures:['steps','ferries','fords'] }),
  ])
  const roadAlts1 = results[0].status === 'fulfilled' ? results[0].value : []
  const roadAlts2 = results[1].status === 'fulfilled' ? results[1].value : []
  const safeAlts  = results[2].status === 'fulfilled' ? results[2].value : []
  const failCount = results.filter(r => r.status === 'rejected').length
  if (failCount > 0) poolWarning = `${failCount} alternative route pool${failCount > 1 ? 's' : ''} unavailable — some options may be limited.`

  const roadPool = byDistinctness([...roadAlts1, ...roadAlts2])
  const safePool = byDistinctness(safeAlts)

  // C) Safest: weighted toward minimum risk, with distance as a small penalty
  const safestCandidates = byDistinctness([...shortestList, ...safePool, ...roadPool])
  const safest = rankSafestCandidate(safestCandidates, shortestDist, riskScore) || shortest

  // D) Long & Scenic: weighted scenic rank under a bounded detour window
  const scenicCandidates = byDistinctness([
    ...roadPool.filter((feature) => !isSameRoute(feature, shortest)),
    ...safePool.filter((feature) => !isSameRoute(feature, shortest)),
  ])
  const longScenic = rankScenicCandidate(
    scenicCandidates,
    shortestDist,
    shortest,
    safest,
    riskScore,
    scenicScore,
  ) || roadPool.filter((feature) => !isSameRoute(feature, shortest))
    .sort(compareByNumber((feature) => -distanceOf(feature)))[0] || shortest

  // E) Return 3 DISTINCT, CLONED, and LABELED
  const out = []
  const pushUnique = (f, label, tag) => {
    if (!f) return
    if (out.some(x => isSameRoute(x, f))) return
    const c = cloneAndLabel(f, label, tag)
    if (!c.properties) c.properties = {}
    c.properties._profile = f.properties?._profile || 'cycling-road'
    out.push(c)
  }

  pushUnique(shortest, 'Shortest', 'shortest')
  pushUnique(safest,  'Safest',   'safest')
  pushUnique(longScenic, 'Long & Scenic', 'long')

  // backfill if we somehow got dupes
  for (const c of [...roadPool, ...safePool]) {
    if (out.length >= 3) break
    if (!out.some(x => isSameRoute(x, c))) pushUnique(c, `Route ${out.length+1}`, 'alt')
  }
  return { routes: out.slice(0, 3), poolWarning }
}





  // routing (uses designated routes)
  const route = async (overrides = {}) => {
    if(!map) return
    setErr(null); setPoolWarning(null); setInsights(null); setRiskMix(null); setRiskBands([]); setDirections([]); setRouting(true)
    setActivePicker(null)
    try{
      const o = overrides.origin || originCoord || (originText ? await geocode(originText) : null)
      const d = overrides.dest   || destCoord   || (destText   ? await geocode(destText)   : null)
      if(!o || !d) throw new Error('Enter origin and destination')
      if (haversineMeters(o, d) < 8) throw new Error('Start and destination are the same point')

      setOriginCoord(o); setDestCoord(d)
      addOrMoveMarker('origin', o); addOrMoveMarker('dest', d)

      const { routes: features, poolWarning: pw } = await fetchThreeRoutes(o, d)
      if (!Array.isArray(features) || !features.length) throw new Error('No route found')
      if (pw) setPoolWarning(pw)

      riskFCCache.current.clear()
      setRoutes(features)           // three designated
      setRouteInsightsCache(features.map(f => getInsights(f)))
      setActiveRouteIdx(0)          // select "Shortest" by default

      lastRouteRef.current = features[0]
      routeCoordsRef.current = features[0].geometry?.coordinates || []

      const url = new URL('https://www.google.com/maps/dir/')
      url.searchParams.set('api','1')
      url.searchParams.set('origin', `${o.lat},${o.lng}`)
      url.searchParams.set('destination', `${d.lat},${d.lng}`)
      url.searchParams.set('travelmode','bicycling')
      const s = url.toString()
      setShareUrl(s)
      if(qrRef.current) await QRCode.toCanvas(qrRef.current, s, { width: 192 })

      setAcResetKey(k => k + 1)
    }catch(e){
      setErr(e?.message || 'Routing failed')
    }finally{ setRouting(false) }
  }

  // camera + cursor + steps
  const pad = () => ({ top:40, right:40, bottom:40, left:(panelRef.current?.offsetWidth ?? 0) + 24 })
  const boundsFor = (feature) => {
    const g = feature?.geometry; if (!g) return null
    const b = new maplibregl.LngLatBounds()
    const add = (pt) => { const [lng,lat] = pt; if (Number.isFinite(lng)&&Number.isFinite(lat)) b.extend([lng,lat]) }
    const addLine = (line) => line.forEach(add)
    if (g.type === 'LineString') addLine(g.coordinates)
    else if (g.type === 'MultiLineString') g.coordinates.forEach(addLine)
    else if (g.type === 'GeometryCollection')
      g.geometries.forEach(gg => (gg.type === 'LineString') ? addLine(gg.coordinates) :
                                gg.type === 'MultiLineString' && gg.coordinates.forEach(addLine))
    return b.isEmpty() ? null : b
  }
  const fitRoute = (feature, { panelAware=true, tightness=1.0, zoomOffset=0 } = {}) => {
    const b = boundsFor(feature); if (!b) return
    const base = panelAware ? pad() : { top:40,right:40,bottom:40,left:40 }
    const p = { top: base.top/tightness, right: base.right/tightness, bottom: base.bottom/tightness, left: base.left/tightness }
    const cam = typeof map?.cameraForBounds === 'function'
      ? map.cameraForBounds(b, { padding:p, maxZoom:18 })
      : { center:b.getCenter(), zoom:14 }
    if (zoomOffset) cam.zoom = Math.min(20, cam.zoom + zoomOffset)
    map.easeTo({ ...cam, bearing:0, pitch:0, duration:700 })
  }
  const defaultRouteView = () => { if (lastRouteRef.current) fitRoute(lastRouteRef.current, { panelAware:false, tightness:1.6 }) }
  const zoomBy = (d) => map && map.easeTo({ zoom: Math.max(1, Math.min(20, map.getZoom()+d)), duration:200 })

  const ensureRouteCursor = () => {
    if (!map || map.getSource('route-cursor')) return
    map.addSource('route-cursor', { type:'geojson', data:{ type:'FeatureCollection', features:[] } })
    map.addLayer({
      id:'route-cursor-layer', type:'circle', source:'route-cursor',
      paint:{ 'circle-radius':6, 'circle-color':'#ffffff', 'circle-stroke-width':3, 'circle-stroke-color':'#2563eb' }
    })
  }
  const updateRouteCursor = (lng, lat) => {
    if (!map || !map.getSource('route-cursor')) return
    map.getSource('route-cursor').setData({ type:'FeatureCollection', features:[{ type:'Feature', geometry:{ type:'Point', coordinates:[lng,lat] } }] })
  }
  const focusAtKm = (km, { panOnly=false } = {}) => {
    const coords = routeCoordsRef.current, distKm = distKmRef.current
    if (!map || !coords?.length || !distKm?.length) return
    let lo=0, hi=distKm.length-1
    while (lo<hi){ const mid=(lo+hi)>>1; (distKm[mid]<km) ? (lo=mid+1) : (hi=mid) }
    const i = Math.max(0, Math.min(distKm.length-1, lo))
    const [lng,lat] = coords[i] || []
    if (!Number.isFinite(lng)||!Number.isFinite(lat)) return
    updateRouteCursor(lng, lat)
    map.easeTo({ center:[lng,lat], zoom:Math.max(map.getZoom(),14), duration: panOnly?150:300 })
  }
  const flatSteps = (feature) => {
    const segs = feature?.properties?.segments || []; const out=[]
    segs.forEach((seg, si) => (seg.steps||[]).forEach((s, idx) => out.push({ ...s, segIndex:si, stepIndex:idx })))
    return out
  }
  const focusStep = (st) => {
    try{
      const wp = Array.isArray(st?.way_points) ? st.way_points : [0,0]
      const mid = Math.round(((wp[0]??0)+(wp[1]??0))/2)
      const coords = routeCoordsRef.current
      if (!map || !coords?.length) return
      const i = Math.max(0, Math.min(coords.length-1, mid))
      const [lng,lat] = coords[i] || []
      ensureRouteCursor(); updateRouteCursor(lng, lat)
      map.easeTo({ center:[lng,lat], zoom:Math.max(map.getZoom(),15), duration:350 })
    }catch{ return }
  }

  const fmtDist = (m) => (m < 950 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`)

  const selectRoute = (idx, feature) => {
    setActiveRouteIdx(idx)
    lastRouteRef.current = feature
    routeCoordsRef.current = feature.geometry?.coordinates || []
    const ins = getInsights(feature)
    setInsights(ins)
    fitRoute(feature, { tightness: 1.6 })
  }

  // ui
  const dragPinStyle = { display:'inline-flex', alignItems:'center', justifyContent:'center', width:36, height:36, marginLeft:8, borderRadius:8, cursor:'grab', border:'1px solid #2a3b5f', background:'#0e172a', fontSize:18, userSelect:'none' }

  return (
    <div className="map-wrap">
      <div className="controls" ref={panelRef}>
        {err && <div role="alert" aria-live="assertive" style={{background:'#3b1f1f',color:'#ffd9d9',padding:8,borderRadius:8,marginBottom:8}}>{err}</div>}
        {poolWarning && <div role="status" style={{background:'#2d2510',color:'#fde68a',padding:8,borderRadius:8,marginBottom:8,fontSize:13}}>{poolWarning}</div>}

        <label>
          Start
          <div className="row">
            <GeoAutocomplete
              key={`origin-${acResetKey}`}
              value={originText}
              onChange={setOriginText}
              onSelect={({center,label})=>{
                const c={lng:center[0],lat:center[1]}
                setOriginCoord(c); setOriginText(label); addOrMoveMarker('origin', c)
                document.activeElement?.blur?.()
              }}
              placeholder="Enter origin"
              onFocus={()=>{ setActivePicker('origin'); setInsights(null) }}
              biasProximity={biasProximity}
              biasBBox={biasBBox}
            />
            <div draggable onDragStart={(e)=>onDragStartPin(e,'origin')} title="Drag this pin onto the map to set Start" aria-grabbed="false" style={{...dragPinStyle, color:'#22c55e'}}>📍</div>
            <button type="button" onClick={()=>applyMyLocation('origin')}>Use my location</button>
          </div>
        </label>

        <label>
          Destination
          <div className="row">
            <GeoAutocomplete
              key={`dest-${acResetKey}`}
              value={destText}
              onChange={setDestText}
              onSelect={({center,label})=>{
                const c={lng:center[0],lat:center[1]}
                setDestCoord(c); setDestText(label); addOrMoveMarker('dest', c)
                document.activeElement?.blur?.()
              }}
              placeholder="Enter destination"
              onFocus={()=>{ setActivePicker('destination'); setInsights(null) }}
              biasProximity={biasProximity}
              biasBBox={biasBBox}
            />
            <div draggable onDragStart={(e)=>onDragStartPin(e,'dest')} title="Drag this pin onto the map to set Destination" aria-grabbed="false" style={{...dragPinStyle, color:'#ef4444'}}>📍</div>
            <button type="button" onClick={()=>applyMyLocation('destination')}>Use my location</button>
          </div>
        </label>

        {activePicker && (
          <div style={{margin:'8px 0', fontSize:12, color:'#9fb1c7'}}>
            Click on the map to set <b>{activePicker === 'origin' ? 'Start' : 'Destination'}</b> • Press <kbd>Esc</kbd> to cancel
          </div>
        )}

        <button className="primary" type="button" onClick={route} disabled={routing} aria-busy={routing} aria-live="polite">
          {routing ? 'Routing…' : 'Find Bike-Safe Route'}
        </button>
        
        {!!routes.length && (
          <div style={{marginTop:12}}>
            <h3 style={{margin:'8px 0', color:'#cfe1ff', fontSize:14}}>Designated Routes</h3>
            <div role="listbox" aria-label="Route options" style={{display:'flex', flexDirection:'column', gap:8}}>
              {routes.map((r, i) => {
                const label = r.properties?._label || r.properties?._preference || `Route ${i+1}`
                const stats = routeInsightsCache[i] || null
                const isActive = i === activeRouteIdx
                return (
                  <button
                    key={i}
                    role="option"
                    aria-selected={isActive}
                    onClick={() => { setActiveRouteIdx(i); selectRoute(i, r) }}
                    style={{
                      textAlign:'left',
                      padding:'8px 10px',
                      borderRadius:6,
                      cursor:'pointer',
                      border:`1px solid ${isActive ? '#60a5fa' : '#2a3b5f'}`,
                      background:isActive ? '#1e293b' : '#0e172a',
                      color:'#cfe1ff'
                    }}
                  >
                    <div style={{fontWeight:600}}>{label}</div>
                    {stats && (
                      <div style={{fontSize:12, opacity:0.8}}>
                        { (stats.totalDistM/1000).toFixed(1) } km • ↑{Math.round(stats.ascentM)}m • ETA {Math.round(stats.etaMin)} min
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div style={{ display:'flex', gap:8, marginTop:8, flexWrap:'wrap' }}>
          <button type="button" className="secondary" onClick={defaultRouteView} title="Frame current route, centered">Default route view</button>
          <button type="button" className="secondary" onClick={() => zoomBy(+1)} title="Zoom in">Zoom +</button>
          <button type="button" className="secondary" onClick={() => zoomBy(-1)} title="Zoom out">Zoom −</button>
        </div>

        <div style={{ display:'flex', gap:8, marginTop:8, alignItems:'center' }}>
          <label style={{ display:'inline-flex', gap:8, alignItems:'center', fontSize:14 }}>
            <input type="checkbox" checked={showCyclePaths} onChange={e => setShowCyclePaths(e.target.checked)} aria-label="Toggle cycle paths overlay" />
            Show cycle paths overlay
          </label>
        </div>

        <RouteInsights
          i={insights}
          bands={riskBands}
          onScrub={(km)=>focusAtKm(km, { panOnly:true })}
          onSelect={(km)=>focusAtKm(km)}
        />

        <div style={{marginTop:8, fontSize:12, color:'#9fb1c7'}} role="legend" aria-label="Risk level legend">
          <div style={{display:'flex', gap:12, alignItems:'center', flexWrap:'wrap'}}>
            <span><b>Risk legend:</b></span>
            <span title="Low risk"><i style={{display:'inline-block',width:10,height:10,background:'#10b981',borderRadius:3,marginRight:4}} aria-hidden="true"/>low (safe)</span>
            <span title="Medium risk"><i style={{display:'inline-block',width:10,height:10,background:'#f59e0b',borderRadius:3,marginRight:4}} aria-hidden="true"/>med (caution)</span>
            <span title="High risk"><i style={{display:'inline-block',width:10,height:10,background:'#ef4444',borderRadius:3,marginRight:4}} aria-hidden="true"/>high (avoid)</span>
          </div>
        </div>

        {riskMix && (
          <div style={{marginTop:8, fontSize:12, color:'#9fb1c7'}}>
            {`Risk mix: ${riskMix.pctLow}% low • ${riskMix.pctMed}% med • ${riskMix.pctHigh}% high`}
          </div>
        )}

        {!!directions.length && (
          <div className="directions-card" style={{marginTop:12, padding:12, borderRadius:8, background:'#0b1220', color:'#e6efff', border:'1px solid #1f2a40'}}>
            <h3 style={{margin:'0 0 6px'}}>Directions</h3>
            <ol style={{margin:0, paddingLeft:18, maxHeight:220, overflow:'auto', fontSize:14}}>
              {directions.map((st) => (
                <li key={`${st.segIndex}-${st.stepIndex}`} style={{margin:'4px 0', lineHeight:1.35}}>
                  <button
                    type="button"
                    onClick={()=>focusStep(st)}
                    style={{marginRight:8, padding:'2px 6px', fontSize:12, cursor:'pointer', borderRadius:6, border:'1px solid #2a3b5f', background:'#0e172a', color:'#cfe1ff'}}
                    title="Focus this step on the map"
                    aria-label={`Focus step ${st.segIndex + 1}-${st.stepIndex + 1}`}
                  >
                    Focus
                  </button>
                  <span>{st.instruction}</span>
                  <span style={{opacity:.7}}> — {fmtDist(st.distance)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {shareUrl && (
          <div className="share" style={{marginTop:12}}>
            <h3>Share to your phone</h3>
            <ShareButtons url={shareUrl} />
            <canvas ref={qrRef} aria-label="QR code for opening this route on your phone" />
            <p><a href={shareUrl} target="_blank" rel="noreferrer">Open route in Google Maps</a></p>
          </div>
        )}
      </div>

      <div style={{position:'relative'}}>
        <div ref={mapRef} className="map" style={{minHeight:'60vh'}} />
        {!mapReady && (
          <div style={{
            position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center',
            background:'#0a0f18', borderRadius:14, zIndex:10, flexDirection:'column', gap:12
          }}>
            <div style={{
              width:36, height:36, border:'3px solid #2a3b5f', borderTopColor:'#60a5fa',
              borderRadius:'50%', animation:'spin 0.8s linear infinite'
            }} />
            <span style={{color:'#9fb1c7', fontSize:13}}>Loading map…</span>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}
      </div>
    </div>
  )
}

// --- parks overlay (simple)
const anyVectorSource = (m) => {
  const srcs = m.getStyle()?.sources || {}
  return Object.keys(srcs).find(k => srcs[k].type === 'vector')
}
const ensureParksOverlay = (m) => {
  const style = m.getStyle() || {}
  const layers = style.layers || []
  const land = layers.find(L => L.type==='fill' && L['source-layer']==='landuse')
  const src = land?.source || anyVectorSource(m); if (!src) return
  const layer = land?.['source-layer'] || 'landuse'
  const parkFilter = ['any',['match',['get','class'],['park','recreation_ground','garden','nature_reserve','protected_area'],true,false],['==',['get','subclass'],'park']]
  if (!m.hasImage('park-icon')) m.addImage('park-icon', makeParkIcon(), { pixelRatio:2 })
  if (!m.getLayer('parks-fill')) m.addLayer({ id:'parks-fill', type:'fill', source:src, 'source-layer':layer, filter:parkFilter, paint:{ 'fill-color':'#22c55e','fill-opacity':0.45 } })
  if (!m.getLayer('parks-outline')) m.addLayer({ id:'parks-outline', type:'line', source:src, 'source-layer':layer, filter:parkFilter, paint:{ 'line-color':'#16a34a','line-width':2,'line-dasharray':[2,2],'line-opacity':0.9 } })
  if (!m.getLayer('parks-icon')) m.addLayer({
    id:'parks-icon', type:'symbol', source:src, 'source-layer':layer, filter:parkFilter, minzoom:10,
    layout:{ 'icon-image':'park-icon','icon-size':['interpolate',['linear'],['zoom'],10,0.9,12,1.0,15,1.2],'icon-allow-overlap':true,'icon-ignore-placement':true,'symbol-placement':'point','icon-offset':[0,-2] }
  })
}
const makeParkIcon = () => {
  const px=64, c=document.createElement('canvas'); c.width=c.height=px
  const ctx=c.getContext('2d'); ctx.fillStyle='#16a34a'
  ctx.beginPath(); ctx.arc(px/2,px/2,22,0,Math.PI*2); ctx.fill()
  ctx.fillStyle='#fff'; ctx.beginPath(); ctx.moveTo(px/2,px/2-14); ctx.lineTo(px/2-13,px/2+4); ctx.lineTo(px/2+13,px/2+4); ctx.closePath(); ctx.fill()
  ctx.fillRect(px/2-3,px/2+4,6,12); return c
}
