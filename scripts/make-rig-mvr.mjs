#!/usr/bin/env node
/**
 * Build `e2e/fixtures/rig.mvr`.
 *
 * The e2e MVR used to be a binary with no provenance — four fixtures and a
 * GDTF profile carrying nothing but channel offsets, which was enough to
 * test the importer and nothing else. Now that the profile drives the live
 * view (intensity, colour, pan and tilt, the channel readout), the fixture
 * has to carry a realistic one, and a checked-in zip nobody can regenerate
 * is a bad way to hold that.
 *
 * Run it after changing anything here:
 *
 *   node scripts/make-rig-mvr.mjs
 *
 * The profile is a plausible 16-channel beam: not a copy of any
 * manufacturer's file, just the shape of one.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'

const IDENTITY = '{1,0,0}{0,1,0}{0,0,1}'

/** `<DMXChannel>` with one logical channel and its functions. */
const channel = (offset, attribute, functions, extra = '') =>
  `<DMXChannel DMXBreak="1" Offset="${offset}" Geometry="Head"${extra}>` +
  `<LogicalChannel Attribute="${attribute}">${functions}</LogicalChannel>` +
  `</DMXChannel>`

const fn = (attribute, from, body = '', physical = '') =>
  `<ChannelFunction Name="${attribute}" Attribute="${attribute}" DMXFrom="${from}/1"${physical}>` +
  body +
  `</ChannelFunction>`

const sharpy = zipSync({
  'description.xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><GDTF DataVersion="1.2">` +
      `<FixtureType Name="Sharpy" Manufacturer="Clay Paky">` +
      `<AttributeDefinitions><Attributes>` +
      `<Attribute Name="Pan" Pretty="P" PhysicalUnit="Angle"/>` +
      `<Attribute Name="Tilt" Pretty="T" PhysicalUnit="Angle"/>` +
      `<Attribute Name="Zoom" Pretty="Zoom" PhysicalUnit="Angle"/>` +
      `<Attribute Name="Shutter1Strobe" Pretty="Strobe" PhysicalUnit="Frequency"/>` +
      `</Attributes></AttributeDefinitions>` +
      // A colour wheel with four real positions, so the plot can be coloured
      // by what the desk selected rather than by nothing.
      `<Wheels><Wheel Name="ColorWheel">` +
      `<Slot Name="Open"/>` +
      `<Slot Name="Red" Color="0.6800,0.3100,15.0"/>` +
      `<Slot Name="Congo" Color="0.1500,0.0600,4.0"/>` +
      `<Slot Name="Amber" Color="0.5200,0.4400,45.0"/>` +
      `</Wheel></Wheels>` +
      `<PhysicalDescriptions><Properties>` +
      `<Weight Value="16.4"/><PowerConsumption Value="440"/>` +
      `</Properties></PhysicalDescriptions>` +
      `<Models>` +
      `<Model Name="Base" Length="0.29" Width="0.34" Height="0.21"/>` +
      `<Model Name="Head" Length="0.24" Width="0.22" Height="0.35"/>` +
      `</Models>` +
      `<Geometries><Geometry Name="Base"><Geometry Name="Yoke">` +
      `<Beam Name="Head" BeamAngle="3.8" LuminousFlux="9000"/>` +
      `</Geometry></Geometry></Geometries>` +
      `<DMXModes><DMXMode Name="Standard" Geometry="Base"><DMXChannels>` +
      channel('1', 'Dimmer', fn('Dimmer', 0)) +
      channel(
        '2',
        'Shutter1',
        `<ChannelFunction Name="Closed" Attribute="Shutter1" DMXFrom="0/1"/>` +
          `<ChannelFunction Name="Open" Attribute="Shutter1" DMXFrom="32/1"/>` +
          `<ChannelFunction Name="Strobe" Attribute="Shutter1Strobe" DMXFrom="64/1" ` +
          `PhysicalFrom="1" PhysicalTo="25"/>`
      ) +
      channel('3,4', 'Pan', fn('Pan', 0, '', ' PhysicalFrom="-270" PhysicalTo="270"')) +
      channel('5,6', 'Tilt', fn('Tilt', 0, '', ' PhysicalFrom="-135" PhysicalTo="135"')) +
      channel(
        '7',
        'Color1',
        `<ChannelFunction Name="Colour" Attribute="Color1" DMXFrom="0/1" Wheel="ColorWheel">` +
          `<ChannelSet Name="Open" DMXFrom="0/1" WheelSlotIndex="1"/>` +
          `<ChannelSet Name="Red" DMXFrom="10/1" WheelSlotIndex="2"/>` +
          `<ChannelSet Name="Congo" DMXFrom="20/1" WheelSlotIndex="3"/>` +
          `<ChannelSet Name="Amber" DMXFrom="30/1" WheelSlotIndex="4"/>` +
          `</ChannelFunction>`
      ) +
      channel('8', 'Gobo1', fn('Gobo1', 0)) +
      channel('9', 'Prism1', fn('Prism1', 0)) +
      channel('10', 'Focus1', fn('Focus1', 0)) +
      channel('11', 'Zoom', fn('Zoom', 0, '', ' PhysicalFrom="3.8" PhysicalTo="3.8"')) +
      // A virtual channel occupies nothing and must not shrink the footprint.
      channel('None', 'Control1', fn('Control1', 0)) +
      // Padding to a 16-channel mode, which is what the importer test checks.
      channel('16', 'Function1', fn('Function1', 0)) +
      `</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`
  ),
})

/** Four beams along one truss, addressed nose to tail at 16 channels each. */
const fixtures = [
  { name: 'Sharpy 3', id: '103', unit: '3', address: 33, x: 3000 },
  { name: 'Sharpy 1', id: '101', unit: '1', address: 1, x: -3000 },
  { name: 'Sharpy 4', id: '104', unit: '4', address: 49, x: 6000 },
  { name: 'Sharpy 2', id: '102', unit: '2', address: 17, x: 0 },
]

const sceneXml =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<GeneralSceneDescription verMajor="1" verMinor="5"><Scene><Layers>` +
  `<Layer name="Upstage Truss" uuid="l-upstage"><ChildList>` +
  fixtures
    .map(
      (f) =>
        `<Fixture name="${f.name}" uuid="u-${f.id}">` +
        `<Matrix>${IDENTITY}{${f.x},6000,8000}</Matrix>` +
        `<GDTFSpec>Clay Paky@Sharpy@v1.gdtf</GDTFSpec>` +
        `<GDTFMode>Standard</GDTFMode>` +
        `<Addresses><Address break="0">${f.address}</Address></Addresses>` +
        `<FixtureID>${f.id}</FixtureID><UnitNumber>${f.unit}</UnitNumber>` +
        `</Fixture>`
    )
    .join('') +
  `</ChildList></Layer></Layers></Scene></GeneralSceneDescription>`

const out = fileURLToPath(new URL('../e2e/fixtures/rig.mvr', import.meta.url))
writeFileSync(
  out,
  zipSync({
    'GeneralSceneDescription.xml': strToU8(sceneXml),
    'Clay Paky@Sharpy@v1.gdtf': sharpy,
  })
)
console.log(`wrote ${out}`)
