package com.formstr.drive;

import android.os.Bundle;

import com.formstr.drive.files.DriveFilesPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(DriveFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
