#include <iostream>
#include <filesystem>
#include <string>

namespace fs = std::filesystem;

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: list_files <root_dir>" << std::endl;
        return 1;
    }
    std::string root = argv[1];
    for (const auto& dirEntry : fs::directory_iterator(root)) {
        if (dirEntry.is_directory()) {
            std::string folder = dirEntry.path().filename().string();
            for (const auto& fileEntry : fs::directory_iterator(dirEntry.path())) {
                if (fileEntry.is_regular_file() && fileEntry.path().extension() == ".wav") {
                    std::string filename = fileEntry.path().filename().string();
                    std::cout << folder << "/" << filename << std::endl;
                }
            }
        }
    }
    return 0;
}