import React, { useEffect, useRef, useState } from 'react'
import { VectorTile } from '@mapbox/vector-tile'
import maplibregl from 'maplibre-gl'
import Pbf from 'pbf'
import QRCode from 'qrcode'
import ShareButtons from './ShareButtons.jsx'
import GeoAutocomplete from './GeoAutocomplete.jsx'
import RouteInsights from './RouteInsights.jsx'
import {
  haversineMeters, toRiskFCRaw, routeSig,
  riskScore as riskScoreRaw,
  getInsights, distanceOf, isSameRoute,
  byDistinctness, cloneAndLabel, wayLabel, INFRA_LABEL,
} from '../utils/scoring.js'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const ORS_KEY      = import.meta.env.VITE_ORS_KEY
const ORS_BASE     = import.meta.env.DEV ? '/ors' : 'https://api.openrouteservice.org'

const DEFAULT_CENTER = [-79.6440, 43.5890]
const DEFAULT_ZOOM   = 12
const SAFETY_DISTANCE_WEIGHT = 0.12
const ROUTE_DIRECTION_ICON_ID = 'route-direction-arrow'
const SCENIC_SOURCE_ID = 'scenic-route-places'
const SCENIC_TILE_ZOOM = 14
const SCENIC_MAX_TILES = 24
const SCENIC_CLICK_RADIUS = 20
const SCENIC_ROUTE_RADIUS_METERS = 1400
const EMPTY_SCENIC_PLACES = { type:'FeatureCollection', features:[] }
const SCENIC_PIN_GROUPS = [
  { id:'scenic-nature-pins', label:'Nature & views', shortLabel:'nature', color:'#16a34a', symbol:'N', limit:10, maxRank:8, categories:['park','garden','viewpoint','picnic_site'] },
  { id:'scenic-place-pins', label:'Plazas & sights', shortLabel:'plazas & sights', color:'#8b5cf6', symbol:'P', limit:12, maxRank:10, categories:['mall','marketplace','attraction','museum','gallery','artwork','monument','arts_centre'] },
  { id:'scenic-cafe-pins', label:'Cafés & treats', shortLabel:'cafés', color:'#ea580c', symbol:'C', limit:14, maxRank:15, categories:['cafe','bakery','ice_cream'] },
  { id:'scenic-cyclist-pins', label:'Cyclist essentials', shortLabel:'bike stops', color:'#0284c7', symbol:'B', limit:14, categories:['bicycle','bicycle_rental','drinking_water','toilets','shelter'] },
]
const SCENIC_PIN_LAYER_IDS = SCENIC_PIN_GROUPS.map(group => group.id)
const SCENIC_LAYER_IDS = [...SCENIC_PIN_LAYER_IDS]
const scenicTileCache = new Map()

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
  const scenicPopupRef = useRef(null)
  const scenicPlacesDataRef = useRef(EMPTY_SCENIC_PLACES)

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
  const [showScenicPlaces, setShowScenicPlaces] = useState(false)
  const [scenicPlacesStatus, setScenicPlacesStatus] = useState({ loading:false, count:0, error:null })
  const CYCLE_LAYER_ID = 'cycle-paths-overlay'
  const CYCLE_CASING_ID = 'cycle-paths-overlay-casing'

  const [biasProximity, setBiasProximity] = useState([DEFAULT_CENTER[0], DEFAULT_CENTER[1]])
  const [biasBBox, setBiasBBox] = useState(null)
  const [acResetKey, setAcResetKey] = useState(0)

  const [routes, setRoutes] = useState([])   // Shortest and Safest
  const [routeInsightsCache, setRouteInsightsCache] = useState([]) // cached getInsights per route
  const [activeRouteIdx, setActiveRouteIdx] = useState(0)
  const riskFCCache = useRef(new Map())  // cache toRiskFC results keyed by routeSig

  // --- risk overlay housekeeping
  const safeRemoveLayer  = (m, id) => { try { if (m.getLayer(id))  m.removeLayer(id) } catch { return } }
  const safeRemoveSource = (m, id) => { try { if (m.getSource(id)) m.removeSource(id) } catch { return } }
  const clearRiskOverlay = (m) => {
    safeRemoveLayer(m, 'route-direction-arrows')
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
          scenicPopupRef.current = new maplibregl.Popup({ closeButton:true, closeOnClick:true, offset:18, maxWidth:'260px' })
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
      // draw designated routes; dim those not active
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

        if (!map.hasImage(ROUTE_DIRECTION_ICON_ID)) {
          map.addImage(ROUTE_DIRECTION_ICON_ID, makeRouteDirectionIcon(), { pixelRatio:2 })
        }
        map.addLayer({
          id:'route-direction-arrows',
          type:'symbol',
          source:'route-risk',
          filter:['all',
            ['!=',['get','way'],4],
            ['!=',['get','way'],6],
            ['!=',['get','infraType'],'separated_path'],
          ],
          layout:{
            'symbol-placement':'line',
            'symbol-spacing':160,
            'icon-image':ROUTE_DIRECTION_ICON_ID,
            'icon-size':['interpolate',['linear'],['zoom'],10,0.85,14,1.05,17,1.2],
            'icon-rotation-alignment':'map',
            'icon-pitch-alignment':'map',
            'icon-keep-upright':false,
            'icon-allow-overlap':true,
            'icon-ignore-placement':true,
          },
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

  // keep the scenic layers in sync with the toggle and style reloads
  useEffect(() => {
    if (!map) return
    const syncScenicPlaces = () => {
      ensureScenicPlacesOverlay(map, scenicPlacesDataRef.current)
      setScenicPlacesVisibility(map, showScenicPlaces)
      if (!showScenicPlaces) scenicPopupRef.current?.remove()
    }
    syncScenicPlaces()
    map.on('styledata', syncScenicPlaces)
    return () => map.off('styledata', syncScenicPlaces)
  }, [map, showScenicPlaces])

  useEffect(() => {
    if (!map || !showScenicPlaces) return
    const controller = new AbortController()
    const activeRoute = routes[activeRouteIdx] || null
    setScenicPlacesStatus(previous => ({ ...previous, loading:true, error:null }))

    fetchScenicPlaces(activeRoute, map, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        scenicPlacesDataRef.current = data
        ensureScenicPlacesOverlay(map, data)
        map.getSource(SCENIC_SOURCE_ID)?.setData(data)
        setScenicPlacesVisibility(map, true)
        setScenicPlacesStatus({ loading:false, count:data.features.length, error:null })
      })
      .catch(error => {
        if (error?.name === 'AbortError') return
        setScenicPlacesStatus(previous => ({ ...previous, loading:false, error:'Scenic pins are unavailable right now.' }))
      })

    return () => controller.abort()
  }, [map, showScenicPlaces, routes, activeRouteIdx])

  useEffect(() => {
    if (!map) return
    const onPinClick = (event) => {
      const layers = SCENIC_PIN_LAYER_IDS.filter(layerId => map.getLayer(layerId))
      if (!layers.length) return
      const { x, y } = event.point
      const features = map.queryRenderedFeatures([
        [x - SCENIC_CLICK_RADIUS, y - SCENIC_CLICK_RADIUS],
        [x + SCENIC_CLICK_RADIUS, y + SCENIC_CLICK_RADIUS],
      ], { layers })
      const feature = features.find(item => item.properties?.['name:latin'] || item.properties?.name) || features[0]
      const groupId = feature?.properties?.scenicGroupId || feature?.layer?.id
      const group = SCENIC_PIN_GROUPS.find(item => item.id === groupId)
      if (!feature || !group || !scenicPopupRef.current) return
      const coordinates = feature.geometry?.type === 'Point' ? feature.geometry.coordinates : event.lngLat
      scenicPopupRef.current
        .setLngLat(coordinates)
        .setDOMContent(createScenicPopupContent(feature, group))
        .addTo(map)
    }
    const onPinEnter = () => { map.getCanvas().style.cursor = 'pointer' }
    const onPinLeave = () => { map.getCanvas().style.cursor = '' }

    map.on('click', onPinClick)
    map.on('mouseenter', SCENIC_PIN_LAYER_IDS, onPinEnter)
    map.on('mouseleave', SCENIC_PIN_LAYER_IDS, onPinLeave)
    return () => {
      map.off('click', onPinClick)
      map.off('mouseenter', SCENIC_PIN_LAYER_IDS, onPinEnter)
      map.off('mouseleave', SCENIC_PIN_LAYER_IDS, onPinLeave)
    }
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
  // riskScore wrapper that uses the cached toRiskFC
  const riskScore = (feature, routeType) => riskScoreRaw(feature, toRiskFC, routeType)


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
  const feats = (json?.features || []).filter(feature => routeRunsStartToDestination(feature, o, d)).map(f => {
    f.properties = { ...(f.properties||{}), _preference: preference, _profile: profile, _directionChecked:true }
    return f
  })
  return feats
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

async function fetchDesignatedRoutes(o, d) {
  // A) Seed the candidate set with ORS shortest-path routes.
  const shortestList = await fetchORSWithAlts(o, d, { profile:'cycling-road', preference:'shortest', altCount:3 })
  if (!shortestList.length) throw new Error('No route (shortest)')

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

  // C) Shortest is the minimum-distance path across every generated candidate.
  const routeCandidates = byDistinctness([...shortestList, ...safePool, ...roadPool])
  const shortest = [...routeCandidates].sort(compareByNumber(
    (feature) => distanceOf(feature),
    (feature) => riskScore(feature, 'shortest'),
  ))[0]
  const shortestDist = distanceOf(shortest)

  // D) Safest is weighted toward minimum risk, with distance as a small penalty.
  const safestCandidates = routeCandidates
  const distinctSafestCandidates = safestCandidates.filter((feature) => !isSameRoute(feature, shortest))
  const safest = rankSafestCandidate(distinctSafestCandidates, shortestDist, riskScore) || shortest

  // E) Return Shortest and Safest as distinct labeled choices when possible.
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

  if (out.length < 2) {
    poolWarning = [poolWarning, 'No distinct safest alternative was available.'].filter(Boolean).join(' ')
  }
  return { routes: out.slice(0, 2), poolWarning }
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

      const { routes: features, poolWarning: pw } = await fetchDesignatedRoutes(o, d)
      if (!Array.isArray(features) || !features.length) throw new Error('No route found')
      if (pw) setPoolWarning(pw)

      riskFCCache.current.clear()
      setRoutes(features)           // Shortest and Safest
      setRouteInsightsCache(features.map(f => getInsights(f)))
      setActiveRouteIdx(0)          // select "Shortest" by default
      setShowScenicPlaces(true)     // show useful places as soon as a route is ready

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
            <div role="note" style={{marginTop:8, fontSize:12, color:'#9fb1c7'}}>
              <span aria-hidden="true" style={{color:'#60a5fa', fontWeight:800, marginRight:5}}>➤</span>
              Road arrows show travel direction. Dedicated bike paths may run both ways.
            </div>
          </div>
        )}

        <div style={{ display:'flex', gap:8, marginTop:8, flexWrap:'wrap' }}>
          <button type="button" className="secondary" onClick={defaultRouteView} title="Frame current route, centered">Default route view</button>
          <button type="button" className="secondary" onClick={() => zoomBy(+1)} title="Zoom in">Zoom +</button>
          <button type="button" className="secondary" onClick={() => zoomBy(-1)} title="Zoom out">Zoom −</button>
        </div>

        <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:10 }}>
          <div style={{fontSize:12, color:'#9fb1c7', fontWeight:600}}>Map details</div>
          <label style={{ display:'inline-flex', gap:8, alignItems:'center', fontSize:14 }}>
            <input type="checkbox" checked={showCyclePaths} onChange={e => setShowCyclePaths(e.target.checked)} aria-label="Toggle cycle paths overlay" style={{flex:'0 0 auto'}} />
            Show cycle paths overlay
          </label>
          <label style={{ display:'inline-flex', gap:8, alignItems:'center', fontSize:14 }}>
            <input type="checkbox" checked={showScenicPlaces} onChange={e => setShowScenicPlaces(e.target.checked)} aria-label="Toggle scenic places overlay" style={{flex:'0 0 auto'}} />
            Show scenic places
          </label>
          {showScenicPlaces && (
            <div role="status" style={{fontSize:12, color:'#b7c7dc'}}>
              <div style={{color:scenicPlacesStatus.error ? '#fca5a5' : '#86efac', marginBottom:4}}>
                {scenicPlacesStatus.loading
                  ? 'Finding cyclist-friendly places…'
                  : scenicPlacesStatus.error || `Showing ${scenicPlacesStatus.count} places ${routes.length ? 'near this route' : 'nearby'}.`}
              </div>
              <div style={{display:'flex', flexWrap:'wrap', gap:'4px 10px'}}>
                {SCENIC_PIN_GROUPS.map(group => (
                  <span key={group.id} style={{display:'inline-flex', alignItems:'center', gap:4}}>
                    <i aria-hidden="true" style={{display:'inline-flex', alignItems:'center', justifyContent:'center', width:16, height:16, borderRadius:'50%', background:group.color, color:'#fff', fontStyle:'normal', fontSize:9, fontWeight:800}}>{group.symbol}</i>
                    {group.shortLabel}
                  </span>
                ))}
              </div>
            </div>
          )}
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

const routeRunsStartToDestination = (feature, origin, destination) => {
  const coordinates = feature?.geometry?.coordinates || []
  if (!coordinates.length) return false
  const first = coordinates[0]
  const last = coordinates[coordinates.length - 1]
  if (!Array.isArray(first) || !Array.isArray(last)) return false
  const forwardDistance = haversineMeters(origin, { lng:first[0], lat:first[1] })
    + haversineMeters(destination, { lng:last[0], lat:last[1] })
  const reverseDistance = haversineMeters(origin, { lng:last[0], lat:last[1] })
    + haversineMeters(destination, { lng:first[0], lat:first[1] })
  return forwardDistance <= reverseDistance
}
const makeRouteDirectionIcon = () => {
  const size = 48
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.beginPath()
  context.moveTo(5,16)
  context.lineTo(26,16)
  context.lineTo(26,7)
  context.lineTo(44,24)
  context.lineTo(26,41)
  context.lineTo(26,32)
  context.lineTo(5,32)
  context.closePath()
  context.fill()
  context.fillStyle = '#1d4ed8'
  context.beginPath()
  context.moveTo(9,20)
  context.lineTo(30,20)
  context.lineTo(30,16)
  context.lineTo(39,24)
  context.lineTo(30,32)
  context.lineTo(30,28)
  context.lineTo(9,28)
  context.closePath()
  context.fill()
  return context.getImageData(0, 0, size, size)
}

// --- scenic places overlay
const ensureScenicPlacesOverlay = (m, data = EMPTY_SCENIC_PLACES) => {
  if (!m.getSource(SCENIC_SOURCE_ID)) {
    m.addSource(SCENIC_SOURCE_ID, { type:'geojson', data })
  }

  for (const group of SCENIC_PIN_GROUPS) {
    if (m.getLayer(group.id)) continue
    m.addLayer({
      id:group.id,
      type:'circle',
      source:SCENIC_SOURCE_ID,
      minzoom:8,
      filter:['==',['get','scenicGroupId'],group.id],
      layout:{ 'circle-sort-key':['coalesce',['get','rank'],999] },
      paint:{
        'circle-radius':['interpolate',['linear'],['zoom'],8,7,11,9,14,11,16,13],
        'circle-color':group.color,
        'circle-opacity':0.96,
        'circle-stroke-color':'#ffffff',
        'circle-stroke-width':3,
      },
    })
  }
}
const setScenicPlacesVisibility = (m, visible) => {
  const visibility = visible ? 'visible' : 'none'
  for (const layerId of SCENIC_LAYER_IDS) {
    if (m.getLayer(layerId) && m.getLayoutProperty(layerId, 'visibility') !== visibility) {
      m.setLayoutProperty(layerId, 'visibility', visibility)
    }
  }
}
const lineCoordinates = (feature) => {
  const geometry = feature?.geometry
  if (!geometry) return []
  if (geometry.type === 'LineString') return geometry.coordinates || []
  if (geometry.type === 'MultiLineString') return (geometry.coordinates || []).flat()
  if (geometry.type === 'GeometryCollection') {
    return (geometry.geometries || []).flatMap(item => lineCoordinates({ geometry:item }))
  }
  return []
}
const sampleCoordinates = (coordinates, limit) => {
  if (coordinates.length <= limit) return coordinates
  return Array.from({ length:limit }, (_, index) => coordinates[Math.round(index * (coordinates.length - 1) / (limit - 1))])
}
const lngLatToTile = ([lng, lat], zoom = SCENIC_TILE_ZOOM) => {
  const scale = 2 ** zoom
  const xFloat = ((lng + 180) / 360) * scale
  const latitude = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180
  const yFloat = ((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2) * scale
  return { x:Math.floor(xFloat), y:Math.floor(yFloat), xFraction:xFloat % 1, yFraction:yFloat % 1, zoom }
}
const addScenicTile = (tiles, x, y, zoom = SCENIC_TILE_ZOOM) => {
  const scale = 2 ** zoom
  if (y < 0 || y >= scale) return
  const wrappedX = ((x % scale) + scale) % scale
  tiles.set(`${zoom}/${wrappedX}/${y}`, { x:wrappedX, y, zoom })
}
const scenicTilesFor = (feature, m) => {
  const coordinates = lineCoordinates(feature)
  const tiles = new Map()

  if (!coordinates.length) {
    const center = m.getCenter()
    const tile = lngLatToTile([center.lng, center.lat])
    for (let xOffset = -1; xOffset <= 1; xOffset++) {
      for (let yOffset = -1; yOffset <= 1; yOffset++) addScenicTile(tiles, tile.x + xOffset, tile.y + yOffset)
    }
    return [...tiles.values()]
  }

  for (const coordinate of sampleCoordinates(coordinates, 600)) {
    const tile = lngLatToTile(coordinate)
    const xOffsets = [0]
    const yOffsets = [0]
    if (tile.xFraction < 0.2) xOffsets.push(-1)
    if (tile.xFraction > 0.8) xOffsets.push(1)
    if (tile.yFraction < 0.2) yOffsets.push(-1)
    if (tile.yFraction > 0.8) yOffsets.push(1)
    for (const xOffset of xOffsets) {
      for (const yOffset of yOffsets) addScenicTile(tiles, tile.x + xOffset, tile.y + yOffset)
    }
  }

  const ordered = [...tiles.values()]
  if (ordered.length <= SCENIC_MAX_TILES) return ordered
  return Array.from({ length:SCENIC_MAX_TILES }, (_, index) => ordered[Math.round(index * (ordered.length - 1) / (SCENIC_MAX_TILES - 1))])
}
const scenicGroupFor = (properties) => {
  const categories = [properties?.class, properties?.subclass]
  return SCENIC_PIN_GROUPS.find(group => categories.some(category => group.categories.includes(category)))
}
const fetchScenicTile = async ({ x, y, zoom }, signal) => {
  const cacheKey = `${zoom}/${x}/${y}`
  if (scenicTileCache.has(cacheKey)) return scenicTileCache.get(cacheKey)
  const response = await fetch(`https://api.maptiler.com/tiles/v3/${zoom}/${x}/${y}.pbf?key=${MAPTILER_KEY}`, { signal })
  if (!response.ok) throw new Error(`Scenic tile request failed (${response.status})`)
  const vectorTile = new VectorTile(new Pbf(new Uint8Array(await response.arrayBuffer())))
  const poiLayer = vectorTile.layers.poi
  const features = []

  if (poiLayer) {
    for (let index = 0; index < poiLayer.length; index++) {
      const tileFeature = poiLayer.feature(index)
      const properties = tileFeature.properties || {}
      const group = scenicGroupFor(properties)
      const rank = Number(properties.rank)
      if (!group || (group.maxRank && Number.isFinite(rank) && rank > group.maxRank)) continue
      const feature = tileFeature.toGeoJSON(x, y, zoom)
      if (feature.geometry?.type !== 'Point') continue
      feature.properties = { ...properties, scenicGroupId:group.id }
      features.push(feature)
    }
  }

  scenicTileCache.set(cacheKey, features)
  return features
}
const distanceToCoordinates = (coordinate, coordinates) => coordinates.reduce((closest, [lng, lat]) => {
  const distance = haversineMeters({ lng:coordinate[0], lat:coordinate[1] }, { lng, lat })
  return Math.min(closest, distance)
}, Infinity)
const fetchScenicPlaces = async (feature, m, signal) => {
  const routeCoordinates = lineCoordinates(feature)
  const center = m.getCenter()
  const distanceCoordinates = routeCoordinates.length
    ? sampleCoordinates(routeCoordinates, 80)
    : [[center.lng, center.lat]]
  const tileResults = await Promise.allSettled(scenicTilesFor(feature, m).map(tile => fetchScenicTile(tile, signal)))
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const successfulResults = tileResults.filter(result => result.status === 'fulfilled')
  if (!successfulResults.length) throw tileResults.find(result => result.status === 'rejected')?.reason || new Error('No scenic tiles loaded')

  const uniqueFeatures = new Map()
  for (const result of successfulResults) {
    for (const item of result.value) {
      const coordinate = item.geometry.coordinates
      const distance = distanceToCoordinates(coordinate, distanceCoordinates)
      if (routeCoordinates.length && distance > SCENIC_ROUTE_RADIUS_METERS) continue
      const properties = item.properties || {}
      const key = `${properties.name || ''}|${properties.class || ''}|${properties.subclass || ''}|${coordinate[0].toFixed(5)}|${coordinate[1].toFixed(5)}`
      if (!uniqueFeatures.has(key)) {
        uniqueFeatures.set(key, { ...item, properties:{ ...properties, scenicDistance:Math.round(distance) } })
      }
    }
  }

  const selected = []
  for (const group of SCENIC_PIN_GROUPS) {
    const matches = [...uniqueFeatures.values()]
      .filter(item => item.properties.scenicGroupId === group.id)
      .sort((left, right) => {
        const leftNamed = left.properties['name:latin'] || left.properties.name
        const rightNamed = right.properties['name:latin'] || right.properties.name
        const leftScore = left.properties.scenicDistance + (leftNamed ? 0 : 350) + (Number(left.properties.rank) || 20) * 15
        const rightScore = right.properties.scenicDistance + (rightNamed ? 0 : 350) + (Number(right.properties.rank) || 20) * 15
        return leftScore - rightScore
      })
      .slice(0, group.limit)
    selected.push(...matches)
  }

  return { type:'FeatureCollection', features:selected }
}
const createScenicPopupContent = (feature, group) => {
  const properties = feature.properties || {}
  const name = properties['name:latin'] || properties.name || group.label
  const detail = String(properties.subclass || properties.class || group.label).replaceAll('_',' ')
  const card = document.createElement('div')
  Object.assign(card.style, { font:'13px system-ui', color:'#102033', lineHeight:'1.35', minWidth:'150px' })
  const category = document.createElement('div')
  category.textContent = group.label
  Object.assign(category.style, { color:group.color, fontSize:'11px', fontWeight:'800', textTransform:'uppercase', letterSpacing:'.04em', marginBottom:'4px' })
  const title = document.createElement('div')
  title.textContent = name
  Object.assign(title.style, { fontWeight:'800', fontSize:'14px', marginBottom:'3px' })
  const subtitle = document.createElement('div')
  subtitle.textContent = detail
  Object.assign(subtitle.style, { color:'#475569', textTransform:'capitalize' })
  card.append(category, title, subtitle)
  return card
}
