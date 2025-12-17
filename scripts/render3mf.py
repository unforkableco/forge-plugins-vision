#!/usr/bin/env python3
"""
Blender-based 3MF renderer for vision validation.

Renders 3MF files from standard views (iso, front, back, left, right, top, bottom)
with proper color support that OpenSCAD's renderer lacks.

Usage:
    blender --background --python render3mf.py -- <input.3mf> <output_dir> [views...]
    
Views:
    iso, front, back, left, right, top, bottom (default: all)
    
Output:
    Creates PNG files named <view>.png in the output directory.
"""

import bpy
import sys
import os
import math
import subprocess
from mathutils import Vector, Euler


def detect_gpu_backend():
    """
    Detect available GPU and return appropriate Blender Cycles device type.

    Returns:
        str: 'OPTIX', 'CUDA', 'HIP', or 'CPU'
    """
    # Check for NVIDIA GPU
    try:
        # Check if nvidia-smi exists and works
        result = subprocess.run(['nvidia-smi', '-L'],
                              capture_output=True,
                              text=True,
                              timeout=2)
        if result.returncode == 0 and 'GPU' in result.stdout:
            print(f"[GPU] Detected NVIDIA GPU: {result.stdout.strip()}")

            # Check if it's an RTX card (supports OptiX)
            if 'RTX' in result.stdout.upper() or 'TESLA' in result.stdout.upper():
                print("[GPU] Using OptiX for best performance")
                return 'OPTIX'
            else:
                print("[GPU] Using CUDA")
                return 'CUDA'
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception) as e:
        pass

    # Check for AMD GPU
    try:
        # Check for ROCm
        result = subprocess.run(['rocminfo'],
                              capture_output=True,
                              text=True,
                              timeout=2)
        if result.returncode == 0 and 'Agent' in result.stdout:
            print(f"[GPU] Detected AMD GPU via ROCm")
            print("[GPU] Using HIP")
            return 'HIP'
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
        pass

    # Check for AMD GPU via device files (fallback)
    if os.path.exists('/dev/kfd') and os.path.exists('/dev/dri'):
        dri_devices = [f for f in os.listdir('/dev/dri') if f.startswith('renderD')]
        if dri_devices:
            print(f"[GPU] Detected AMD GPU via device files: {dri_devices}")
            print("[GPU] Using HIP")
            return 'HIP'

    # Fallback to CPU
    print("[GPU] No GPU detected, using CPU rendering")
    return 'CPU'


def configure_gpu_device(device_type):
    """
    Configure Blender to use the specified device type.

    Args:
        device_type: 'OPTIX', 'CUDA', 'HIP', or 'CPU'
    """
    if device_type == 'CPU':
        return  # CPU is default, no configuration needed

    try:
        # Get Cycles preferences
        prefs = bpy.context.preferences.addons['cycles'].preferences

        # Map our device types to Blender's compute device types
        compute_device_map = {
            'OPTIX': 'OPTIX',
            'CUDA': 'CUDA',
            'HIP': 'HIP'
        }

        compute_device = compute_device_map.get(device_type)
        if not compute_device:
            print(f"[GPU] Unknown device type: {device_type}, falling back to CPU")
            return

        # Set compute device type
        prefs.compute_device_type = compute_device

        # Refresh devices list
        prefs.get_devices()

        # Enable all available devices of this type
        devices_found = False
        for device in prefs.devices:
            if device.type == compute_device:
                device.use = True
                devices_found = True
                print(f"[GPU] Enabled device: {device.name} ({device.type})")

        if not devices_found:
            print(f"[GPU] Warning: {compute_device} selected but no devices found, using CPU")

    except Exception as e:
        print(f"[GPU] Error configuring GPU: {e}, falling back to CPU")


def clear_scene():
    """Remove all objects from the scene."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    
    # Also clear orphan data
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        if block.users == 0:
            bpy.data.materials.remove(block)


def import_3mf(filepath):
    """Import a 3MF file into Blender, with fallback for materials."""
    # Check if file exists
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"3MF file not found: {filepath}")
    
    # Try importing as 3MF (Blender 2.82+ has experimental support)
    # If 3MF import fails, we can try to extract and import the mesh
    try:
        # Blender 2.83+ has native 3MF support
        # NOTE: Native importer might miss materials or not handle alpha correctly
        # We will try native first, then check if we need to fix materials
        bpy.ops.import_mesh.threemf(filepath=filepath)
        
        # Check if we got any materials. If not, or if they are "invisible", we might need to fix them
        has_materials = False
        for obj in bpy.context.scene.objects:
            if obj.type == 'MESH' and len(obj.data.materials) > 0:
                has_materials = True
                break
        
        if not has_materials:
            print("Native import resulted in no materials. Trying manual import...")
            raise AttributeError("Force manual import") # Trigger fallback
            
    except (AttributeError, RuntimeError):
        # Fallback: 3MF is a ZIP file containing model.xml with mesh data
        # For older Blender versions, we need a different approach
        import zipfile
        import tempfile
        import xml.etree.ElementTree as ET
        
        print("Using manual 3MF importer...")
        
        with zipfile.ZipFile(filepath, 'r') as zf:
            # Find the model file (usually 3D/3dmodel.model)
            model_file = None
            for name in zf.namelist():
                if name.endswith('.model'):
                    model_file = name
                    break
            
            if not model_file:
                raise ValueError("No .model file found in 3MF archive")
            
            # Parse the model XML
            with zf.open(model_file) as f:
                tree = ET.parse(f)
                root = tree.getroot()
                
                # Extract namespace
                ns = {'m': 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'}
                
                # 1. Parse Materials (BaseMaterials)
                # Map id -> blender_material
                materials_map = {}
                
                # Find all resources/basematerials
                resources = root.find('m:resources', ns)
                if resources is not None:
                    for basemat_group in resources.findall('.//m:basematerials', ns):
                        group_id = basemat_group.get('id')
                        for base in basemat_group.findall('m:base', ns):
                            base_name = base.get('name', 'Material')
                            display_color = base.get('displaycolor', '#FFFFFF')
                            
                            # Parse Hex Color #RRGGBBAA or #RRGGBB
                            if display_color.startswith('#'):
                                hex_col = display_color[1:]
                                if len(hex_col) == 6:
                                    r = int(hex_col[0:2], 16) / 255.0
                                    g = int(hex_col[2:4], 16) / 255.0
                                    b = int(hex_col[4:6], 16) / 255.0
                                    a = 1.0
                                elif len(hex_col) == 8:
                                    r = int(hex_col[0:2], 16) / 255.0
                                    g = int(hex_col[2:4], 16) / 255.0
                                    b = int(hex_col[4:6], 16) / 255.0
                                    a = int(hex_col[6:8], 16) / 255.0
                                else:
                                    r, g, b, a = 0.8, 0.8, 0.8, 1.0
                            else:
                                r, g, b, a = 0.8, 0.8, 0.8, 1.0
                            
                            # CRITICAL FIX: If alpha is 0 but color is present, assume it should be opaque
                            # Many 3MF exporters write #RRGGBB00 by mistake or for specific purposes
                            if a < 0.01:
                                print(f"Fixing invisible material '{base_name}' (alpha=0 -> 1.0)")
                                a = 1.0
                                
                            # Create Blender Material
                            mat = bpy.data.materials.new(name=base_name)
                            mat.use_nodes = True
                            bsdf = mat.node_tree.nodes.get("Principled BSDF")
                            if bsdf:
                                bsdf.inputs['Base Color'].default_value = (r, g, b, a)
                                bsdf.inputs['Roughness'].default_value = 0.5
                                bsdf.inputs['Metallic'].default_value = 0.1
                            
                            # Store in map: (group_id, base_index) -> material
                            # 3MF refers to materials by (pid, p1) where pid=group_id, p1=index_in_group
                            # We can't easily get index without counter, so let's re-iterate or use list
                            pass 

                    # Re-iterate to build map with correct indices
                    for basemat_group in resources.findall('.//m:basematerials', ns):
                        group_id = basemat_group.get('id')
                        for idx, base in enumerate(basemat_group.findall('m:base', ns)):
                            base_name = base.get('name', f'Material_{group_id}_{idx}')
                            # Find the material we just created (by name) or create new if name collision
                            mat = bpy.data.materials.get(base_name)
                            if not mat:
                                # Fallback re-creation if needed (unlikely)
                                mat = bpy.data.materials.new(name=base_name)
                            
                            materials_map[(group_id, str(idx))] = mat

                # 2. Parse Objects and Meshes
                for obj in root.findall('.//m:object', ns):
                    obj_pid = obj.get('pid') # Default property ID for the object
                    obj_p1 = obj.get('p1')   # Default property index
                    
                    mesh_elem = obj.find('.//m:mesh', ns)
                    if mesh_elem is None:
                        continue
                    
                    vertices_elem = mesh_elem.find('m:vertices', ns)
                    triangles_elem = mesh_elem.find('m:triangles', ns)
                    
                    if vertices_elem is None or triangles_elem is None:
                        continue
                    
                    # Parse vertices
                    vertices = []
                    for v in vertices_elem.findall('m:vertex', ns):
                        x = float(v.get('x', 0))
                        y = float(v.get('y', 0))
                        z = float(v.get('z', 0))
                        vertices.append((x, y, z))
                    
                    # Parse triangles and materials
                    faces = []
                    face_materials = [] # List of material indices per face
                    
                    # Track unique materials used in this mesh to assign to object slots
                    used_materials = [] 
                    
                    for t in triangles_elem.findall('m:triangle', ns):
                        v1 = int(t.get('v1', 0))
                        v2 = int(t.get('v2', 0))
                        v3 = int(t.get('v3', 0))
                        faces.append((v1, v2, v3))
                        
                        # Determine material for this face
                        # Priority: Triangle attributes > Object attributes
                        pid = t.get('pid', obj_pid)
                        p1 = t.get('p1', obj_p1)
                        
                        mat = None
                        if pid and p1:
                            mat = materials_map.get((pid, p1))
                        
                        if mat:
                            if mat not in used_materials:
                                used_materials.append(mat)
                            face_materials.append(used_materials.index(mat))
                        else:
                            face_materials.append(0) # Default/None
                    
                    # Create mesh in Blender
                    mesh = bpy.data.meshes.new("imported_mesh")
                    mesh.from_pydata(vertices, [], faces)
                    
                    # Assign materials to mesh
                    for mat in used_materials:
                        mesh.materials.append(mat)
                    
                    # Assign material indices to faces
                    if face_materials and used_materials:
                        mesh.update() # Ensure polygons are ready
                        # Validate count
                        if len(mesh.polygons) == len(face_materials):
                            for i, poly in enumerate(mesh.polygons):
                                poly.material_index = face_materials[i]
                    
                    mesh.update()
                    
                    obj_blender = bpy.data.objects.new("imported_object", mesh)
                    bpy.context.collection.objects.link(obj_blender)
    
    return True


def setup_camera_for_view(view_name, bounds_center, bounds_size, max_dim=None):
    """
    Set up camera for a specific view.
    Uses Blender's standard view directions with optimal framing.
    """
    # Calculate distance based on model size - use larger distance for better feature visibility
    if max_dim is None:
        max_dim = max(bounds_size)
    distance = max_dim * 3.0  # Increased from 2.5 for better overview
    
    # Create camera if it doesn't exist
    if 'RenderCamera' not in bpy.data.cameras:
        cam_data = bpy.data.cameras.new('RenderCamera')
        cam_obj = bpy.data.objects.new('RenderCamera', cam_data)
        bpy.context.collection.objects.link(cam_obj)
    else:
        cam_obj = bpy.data.objects['RenderCamera']
    
    # Set camera as active
    bpy.context.scene.camera = cam_obj
    
    # View directions - optimized for feature visibility
    # Slightly angled views show depth better than pure orthogonal
    view_configs = {
        'iso': {
            'location_offset': Vector((1, 1, 1)),
            'track_to_target': True
        },
        'front': {
            'location_offset': Vector((0, -1, 0)),
            'track_to_target': True
        },
        'back': {
            'location_offset': Vector((0, 1, 0)),
            'track_to_target': True
        },
        'left': {
            'location_offset': Vector((-1, 0, 0)),
            'track_to_target': True
        },
        'right': {
            'location_offset': Vector((1, 0, 0)),
            'track_to_target': True
        },
        'top': {
            'location_offset': Vector((0, 0, 1)),
            'track_to_target': True
        },
        'bottom': {
            'location_offset': Vector((0, 0, -1)),
            'track_to_target': True
        }
    }
    
    config = view_configs.get(view_name, view_configs['iso'])
    
    # Set camera location
    offset = config['location_offset'].normalized() * distance
    cam_obj.location = Vector(bounds_center) + offset
    
    # Point camera at center
    direction = Vector(bounds_center) - cam_obj.location
    rot_quat = direction.to_track_quat('-Z', 'Y')
    cam_obj.rotation_euler = rot_quat.to_euler()
    
    # Use orthographic projection for all views (consistent style)
    cam_obj.data.type = 'ORTHO'
    cam_obj.data.ortho_scale = max_dim * 1.8  # Add padding around model
    
    # Ensure clipping planes encompass large assemblies (prevents empty renders)
    cam_obj.data.clip_start = 0.1
    cam_obj.data.clip_end = max(distance * 2.0, max_dim * 5.0)
    
    return cam_obj


def setup_lighting(bounds_center, max_dim):
    """Set up three-point lighting for optimal feature visibility."""
    # Remove existing lights
    for obj in bpy.data.objects:
        if obj.type == 'LIGHT':
            bpy.data.objects.remove(obj)
    
    cx, cy, cz = bounds_center.x, bounds_center.y, bounds_center.z
    d = max_dim * 2.5  # Light distance
    
    # Key light (main, from upper-front-right) - strongest
    key_data = bpy.data.lights.new("KeyLight", type='AREA')
    key_data.energy = 300  # Strong main light
    key_data.size = max_dim * 2
    key = bpy.data.objects.new(name="KeyLight", object_data=key_data)
    bpy.context.collection.objects.link(key)
    key.location = (cx + d * 0.8, cy - d * 0.8, cz + d * 1.0)
    direction = Vector(bounds_center) - key.location
    key.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    
    # Fill light (from upper-front-left) - softer, fills shadows
    fill_data = bpy.data.lights.new("FillLight", type='AREA')
    fill_data.energy = 150  # Softer fill
    fill_data.size = max_dim * 3
    fill = bpy.data.objects.new(name="FillLight", object_data=fill_data)
    bpy.context.collection.objects.link(fill)
    fill.location = (cx - d * 0.6, cy - d * 0.6, cz + d * 0.5)
    direction = Vector(bounds_center) - fill.location
    fill.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    
    # Rim/back light (from behind-above) - highlights edges
    rim_data = bpy.data.lights.new("RimLight", type='AREA')
    rim_data.energy = 200  # Strong rim for edge definition
    rim_data.size = max_dim * 2
    rim = bpy.data.objects.new(name="RimLight", object_data=rim_data)
    bpy.context.collection.objects.link(rim)
    rim.location = (cx, cy + d * 0.8, cz + d * 0.8)
    direction = Vector(bounds_center) - rim.location
    rim.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    
    # Bottom fill (prevents pure black bottoms)
    bottom_data = bpy.data.lights.new("BottomFill", type='AREA')
    bottom_data.energy = 50  # Very soft
    bottom_data.size = max_dim * 4
    bottom = bpy.data.objects.new(name="BottomFill", object_data=bottom_data)
    bpy.context.collection.objects.link(bottom)
    bottom.location = (cx, cy, cz - d * 0.5)
    bottom.rotation_euler = Euler((math.radians(90), 0, 0), 'XYZ')


def setup_materials():
    """Apply a proper 3D material to all mesh objects if they don't have one."""
    # Create a default material if none exists
    mat_name = "DefaultMaterial"
    if mat_name not in bpy.data.materials:
        mat = bpy.data.materials.new(name=mat_name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            # Gray color with good 3D properties
            bsdf.inputs['Base Color'].default_value = (0.6, 0.6, 0.6, 1.0)
            bsdf.inputs['Roughness'].default_value = 0.5
            bsdf.inputs['Metallic'].default_value = 0.0
    else:
        mat = bpy.data.materials[mat_name]
    
    # Apply to all mesh objects
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH':
            # Only apply default material if the object has NO materials
            if len(obj.data.materials) == 0:
                obj.data.materials.append(mat)
            
            # Ensure smooth shading for better 3D appearance
            for poly in obj.data.polygons:
                poly.use_smooth = True
            obj.data.use_auto_smooth = True
            obj.data.auto_smooth_angle = math.radians(40)


def get_scene_bounds():
    """Calculate bounding box of all mesh objects in scene."""
    min_coord = Vector((float('inf'), float('inf'), float('inf')))
    max_coord = Vector((float('-inf'), float('-inf'), float('-inf')))
    
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH':
            # Get world-space bounding box
            for corner in obj.bound_box:
                world_corner = obj.matrix_world @ Vector(corner)
                min_coord.x = min(min_coord.x, world_corner.x)
                min_coord.y = min(min_coord.y, world_corner.y)
                min_coord.z = min(min_coord.z, world_corner.z)
                max_coord.x = max(max_coord.x, world_corner.x)
                max_coord.y = max(max_coord.y, world_corner.y)
                max_coord.z = max(max_coord.z, world_corner.z)
    
    if min_coord.x == float('inf'):
        # No objects found, return defaults
        return Vector((0, 0, 0)), Vector((1, 1, 1))
    
    center = (min_coord + max_coord) / 2
    size = max_coord - min_coord
    
    return center, size


def setup_render_settings(width=800, height=800, max_dim=1.0, device_type='CPU'):
    """Configure render settings for optimal feature visibility.

    Uses Cycles renderer with Freestyle for edge rendering.
    EEVEE doesn't support Freestyle in Blender 2.82, and Workbench
    crashes in headless/WSL environments (needs OpenGL).

    Args:
        width: Render width in pixels
        height: Render height in pixels
        max_dim: Maximum dimension of the model
        device_type: 'CPU', 'CUDA', 'OPTIX', or 'HIP'
    """
    scene = bpy.context.scene

    # Resolution
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100

    # Output format
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.compression = 15

    # Use Cycles - only renderer that supports Freestyle in headless mode
    scene.render.engine = 'CYCLES'

    # Configure device based on detection
    if device_type == 'CPU':
        scene.cycles.device = 'CPU'
        # Allow overriding samples via env var, default to 8 for CPU if not set
        custom_samples = os.environ.get('RENDER_SAMPLES')
        if custom_samples:
             scene.cycles.samples = int(custom_samples)
        else:
             scene.cycles.samples = 8     # CPU: reduced samples for faster renders
    else:
        scene.cycles.device = 'GPU'
        # Allow overriding samples via env var, default to 128 for GPU if not set
        custom_samples = os.environ.get('RENDER_SAMPLES')
        if custom_samples:
             scene.cycles.samples = int(custom_samples)
        else:
             scene.cycles.samples = 128   # GPU: keep higher quality when available

    scene.cycles.use_denoising = False  # Keep edges sharp
    
    # Transparent background
    scene.render.film_transparent = True
    
    # Enable Freestyle for edge rendering
    scene.render.use_freestyle = True
    scene.render.line_thickness_mode = 'ABSOLUTE'
    scene.render.line_thickness = 1.5  # Base line thickness
    
    # Configure Freestyle on view layer
    view_layer = bpy.context.view_layer
    view_layer.use_freestyle = True
    view_layer.use_pass_ambient_occlusion = True
    
    # Freestyle settings
    freestyle = view_layer.freestyle_settings
    # Crease angle: edges with angle LESS than this are drawn
    # Large assemblies include chamfers > 134°, so raise the threshold
    freestyle.crease_angle = math.radians(175)  # Capture shallow chamfers without losing 90° edges
    
    # Get or create lineset
    while len(freestyle.linesets) < 2:
        idx = len(freestyle.linesets)
        freestyle.linesets.new("DetailLines" if idx == 0 else "SilhouetteLines")
    
    detail_set = freestyle.linesets[0]
    detail_set.name = "DetailLines"
    detail_set.select_silhouette = False
    detail_set.select_border = True
    detail_set.select_crease = True
    detail_set.select_contour = False
    detail_set.select_external_contour = False
    detail_set.select_edge_mark = False
    detail_set.select_suggestive_contour = False
    detail_set.select_ridge_valley = False
    detail_set.select_material_boundary = True
    
    if detail_set.linestyle is None:
        detail_set.linestyle = bpy.data.linestyles.new("DetailLineStyle")
    detail_style = detail_set.linestyle
    detail_style.color = (0.3, 0.3, 0.3)
    detail_style.thickness = 1.2
    detail_style.alpha = 0.95
    
    silhouette_set = freestyle.linesets[1]
    silhouette_set.name = "SilhouetteLines"
    silhouette_set.select_silhouette = True
    silhouette_set.select_border = True
    silhouette_set.select_crease = False
    silhouette_set.select_contour = True
    silhouette_set.select_external_contour = True
    silhouette_set.select_edge_mark = False
    silhouette_set.select_suggestive_contour = False
    silhouette_set.select_ridge_valley = False
    silhouette_set.select_material_boundary = False
    
    if silhouette_set.linestyle is None:
        silhouette_set.linestyle = bpy.data.linestyles.new("SilhouetteLineStyle")
    silhouette_style = silhouette_set.linestyle
    silhouette_style.color = (0.05, 0.05, 0.05)
    silhouette_style.thickness = 2.4
    silhouette_style.alpha = 1.0
    
    # Set world background
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    scene.world.use_nodes = True
    bg_node = scene.world.node_tree.nodes.get('Background')
    if bg_node:
        bg_node.inputs['Color'].default_value = (0.95, 0.95, 0.97, 1.0)  # Light gray
        bg_node.inputs['Strength'].default_value = 1.0

    setup_ambient_occlusion_compositor()


def setup_ambient_occlusion_compositor(ao_strength: float = 0.35, cavity_strength: float = 0.2):
    """Overlay ambient occlusion and cavity shading for on-model shadows."""
    scene = bpy.context.scene
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()

    render_layer = tree.nodes.new('CompositorNodeRLayers')
    ao_output = render_layer.outputs.get('AO') or render_layer.outputs.get('Ambient Occlusion')
    
    if not ao_output:
        composite = tree.nodes.new('CompositorNodeComposite')
        tree.links.new(render_layer.outputs['Image'], composite.inputs['Image'])
        alpha_output = render_layer.outputs.get('Alpha')
        if alpha_output:
            tree.links.new(alpha_output, composite.inputs['Alpha'])
        return
    
    ao_curve = tree.nodes.new('CompositorNodeCurveRGB')
    ao_curve.label = 'AO Curve'
    tree.links.new(ao_output, ao_curve.inputs['Image'])
    ao_curve.mapping.curves[3].points.new(0.4, 0.2)
    ao_curve.mapping.curves[3].points.new(0.8, 0.6)
    
    ao_mix = tree.nodes.new('CompositorNodeMixRGB')
    ao_mix.blend_type = 'MULTIPLY'
    ao_mix.inputs[0].default_value = ao_strength
    tree.links.new(render_layer.outputs['Image'], ao_mix.inputs[1])
    tree.links.new(ao_curve.outputs['Image'], ao_mix.inputs[2])
    
    cavity_curve = tree.nodes.new('CompositorNodeCurveRGB')
    cavity_curve.label = 'Cavity Curve'
    tree.links.new(ao_output, cavity_curve.inputs['Image'])
    cavity_curve.mapping.curves[3].points.new(0.2, 0.0)
    cavity_curve.mapping.curves[3].points.new(0.6, 0.1)
    
    cavity_mix = tree.nodes.new('CompositorNodeMixRGB')
    cavity_mix.blend_type = 'MULTIPLY'
    cavity_mix.inputs[0].default_value = cavity_strength
    tree.links.new(ao_mix.outputs['Image'], cavity_mix.inputs[1])
    tree.links.new(cavity_curve.outputs['Image'], cavity_mix.inputs[2])
    
    composite = tree.nodes.new('CompositorNodeComposite')
    tree.links.new(cavity_mix.outputs[0], composite.inputs['Image'])
    
    alpha_output = render_layer.outputs.get('Alpha')
    if alpha_output:
        tree.links.new(alpha_output, composite.inputs['Alpha'])


def render_view(view_name, output_path, bounds_center, bounds_size, max_dim=None):
    """Render a single view and save to file."""
    setup_camera_for_view(view_name, bounds_center, bounds_size, max_dim)
    
    # Set output path
    bpy.context.scene.render.filepath = output_path
    
    # Render
    bpy.ops.render.render(write_still=True)
    
    return os.path.exists(output_path)


def main():
    """Main entry point."""
    # Parse arguments after '--'
    argv = sys.argv
    if '--' in argv:
        argv = argv[argv.index('--') + 1:]
    else:
        print("Usage: blender --background --python render3mf.py -- <input.3mf> <output_dir> [views...]")
        sys.exit(1)
    
    if len(argv) < 2:
        print("Error: Missing required arguments")
        print("Usage: blender --background --python render3mf.py -- <input.3mf> <output_dir> [views...]")
        sys.exit(1)
    
    input_file = argv[0]
    output_dir = argv[1]
    
    # Parse views (default: all standard views)
    default_views = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom']
    views = argv[2:] if len(argv) > 2 else default_views
    
    # Validate views
    valid_views = {'iso', 'front', 'back', 'left', 'right', 'top', 'bottom'}
    for v in views:
        if v not in valid_views:
            print(f"Warning: Unknown view '{v}', skipping")
    views = [v for v in views if v in valid_views]
    
    # Create output directory
    os.makedirs(output_dir, exist_ok=True)
    
    # Clear scene
    clear_scene()
    
    # Import 3MF
    print(f"Importing: {input_file}")
    try:
        import_3mf(input_file)
    except Exception as e:
        print(f"Error importing 3MF: {e}")
        sys.exit(1)
    
    # Apply materials for proper 3D visualization
    setup_materials()

    # Get scene bounds
    bounds_center, bounds_size = get_scene_bounds()
    print(f"Model bounds: center={bounds_center}, size={bounds_size}")

    # Detect and configure GPU
    print("\n=== GPU Detection ===")
    device_type = detect_gpu_backend()
    configure_gpu_device(device_type)
    print("====================\n")

    # Setup lighting and render settings
    max_dim = max(bounds_size.x, bounds_size.y, bounds_size.z, 1.0)
    setup_lighting(bounds_center, max_dim)
    
    # Get resolution from env or default to 500
    resolution = int(os.environ.get('RENDER_RESOLUTION', '500'))
    setup_render_settings(width=resolution, height=resolution, max_dim=max_dim, device_type=device_type)
    
    # Render each view
    results = {}
    for view in views:
        output_path = os.path.join(output_dir, f"preview_{view}.png")
        print(f"Rendering view: {view} -> {output_path}")
        try:
            success = render_view(view, output_path, bounds_center, bounds_size, max_dim)
            results[view] = 'success' if success else 'failed'
        except Exception as e:
            print(f"Error rendering {view}: {e}")
            results[view] = 'error'
    
    # Print summary
    print("\nRender Summary:")
    for view, status in results.items():
        print(f"  {view}: {status}")
    
    # Exit with success if at least one view rendered
    successful = sum(1 for s in results.values() if s == 'success')
    print(f"\nCompleted: {successful}/{len(views)} views rendered")
    
    if successful == 0:
        sys.exit(1)


if __name__ == '__main__':
    main()


