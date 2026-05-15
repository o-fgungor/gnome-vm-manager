import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";

export const VmIndicator = GObject.registerClass(
class VmIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, "VM Manager", false);

        this._box = new St.BoxLayout({
            style_class: "panel-status-indicators-box",
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this._icon = new St.Icon({
            icon_name: "computer-symbolic",
            style_class: "system-status-icon",
            icon_size: 18,
        });

        this._label = new St.Label({
            text: "",
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);
    }

    update(runningCount, totalCount, hasPaused, hasDanger) {
        this._label.text = totalCount > 0 ? ` ${runningCount}/${totalCount}` : "";

        this._icon.remove_style_class_name("vm-panel-icon-danger");
        this._icon.remove_style_class_name("vm-panel-icon-warning");
        this._icon.remove_style_class_name("vm-panel-icon-running");

        if (hasDanger)
            this._icon.add_style_class_name("vm-panel-icon-danger");
        else if (hasPaused)
            this._icon.add_style_class_name("vm-panel-icon-warning");
        else if (runningCount > 0)
            this._icon.add_style_class_name("vm-panel-icon-running");
    }
});
